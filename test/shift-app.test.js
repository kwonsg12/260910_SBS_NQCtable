const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

// 교대 앱(shift/)을 근무표 서버가 /shift/ 에서 띄운다. 진짜 서버를 임시 폴더에서 돌려 확인한다.
// 지키는 것: 앱과 앱이 부르는 파일이 다 열린다, 스크립트가 CSP 에 허락돼 있다, shift/ 아래 다른 파일은 안 열린다.
const projectRoot = path.resolve(__dirname, '..');

function request(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end();
  });
}

async function unusedPort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));
  return port;
}

test('교대 앱을 /shift/ 에서 띄운다', { timeout: 30000 }, async t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nqc-shift-test-'));
  let child, childExit;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (childExit) await childExit;
    const resolved = path.resolve(fixture);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const file of ['server.js', 'excel-export.js', 'my-schedule-mail.js', 'db.js', 'security.js', 'activityLog.js', 'employeeNames.js', 'backup.js', 'notifier.js', 'digest.js', 'index.html', 'sbs-logo.png']) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(fixture, file));
  }
  fs.cpSync(path.join(projectRoot, 'shift'), path.join(fixture, 'shift'), { recursive: true });
  fs.writeFileSync(path.join(fixture, 'shift', 'private.txt'), 'TEST_SENTINEL=not-public\n');

  const port = await unusedPort();
  child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
    cwd: fixture,
    env: { ...process.env, PORT: String(port), NODE_PATH: path.join(projectRoot, 'node_modules'), SMTP_HOST: '', ADMIN_PASSWORD: 'test-admin-password-only' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
  });
  childExit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output);
    try { if ((await request(port, '/api/state')).status === 200) { ready = true; break; } } catch {}
    await delay(50);
  }
  assert.ok(ready, 'Server did not start: ' + output);

  await t.test('/shift 는 /shift/ 로 보내고, /shift/ 는 앱 화면', async () => {
    const redirect = await request(port, '/shift');
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, '/shift/');
    const page = await request(port, '/shift/');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-type'], /text\/html/);
    assert.deepEqual(page.body, fs.readFileSync(path.join(fixture, 'shift', 'index.html')));
  });

  await t.test('앱의 스크립트가 CSP 에 허락돼 있다', async () => {
    const html = fs.readFileSync(path.join(fixture, 'shift', 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
    assert.ok(scripts.length > 0);
    const csp = (await request(port, '/shift/')).headers['content-security-policy'];
    for (const match of scripts) {
      assert.ok(csp.includes("'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'"), '교대 앱 스크립트가 막힌다');
    }
    assert.match(csp, /script-src-attr 'none'/);
  });

  await t.test('앱이 부르는 파일(manifest·아이콘·sw)이 다 열린다', async () => {
    const html = fs.readFileSync(path.join(fixture, 'shift', 'index.html'), 'utf8');
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture, 'shift', 'manifest.webmanifest'), 'utf8'));
    const local = [...html.matchAll(/(?:src|href)=["']([^"'#]+)["']/g)].map(m => m[1]).filter(u => !/^(?:https?:|data:)/.test(u));
    const urls = [...local, ...manifest.icons.map(i => i.src), 'sw.js', 'icons/icon-maskable-512.png'];
    for (const url of urls) {
      const pathname = new URL(url, 'http://localhost/shift/').pathname;
      const res = await request(port, pathname);
      assert.equal(res.status, 200, pathname);
      assert.deepEqual(res.body, fs.readFileSync(path.join(fixture, pathname.slice(1))), pathname);
    }
    assert.match((await request(port, '/shift/manifest.webmanifest')).headers['content-type'], /application\/manifest\+json/);
  });

  await t.test('shift/ 아래 목록에 없는 파일은 안 열린다', async () => {
    for (const url of ['/shift/private.txt', '/shift/../.env', '/shift/icons/', '/shift/%2e%2e/server.js']) {
      const res = await request(port, url);
      assert.notEqual(res.status, 200, url);
      assert.ok(!res.body.toString().includes('TEST_SENTINEL'), url);
    }
  });
});
