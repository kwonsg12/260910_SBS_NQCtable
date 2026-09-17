const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function request(port, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1', port, path: pathname, method,
      headers: payload === undefined ? {} : {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      }));
      res.on('error', reject);
    });
    req.setTimeout(2000, () => req.destroy(new Error('HTTP request timed out')));
    req.on('error', reject);
    req.end(payload);
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

test('HTTP file boundary and existing API routes', { timeout: 30000 }, async t => {
  // Run the real server against disposable files and a fresh SQLite DB.
  // Never open the working directory's DB or enable notification delivery.
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nqc-http-test-'));
  let child;
  let childExit;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (childExit) await childExit;
    const resolved = path.resolve(fixture);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('nqc-http-test-'));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  for (const file of [
    'server.js', 'db.js', 'notifier.js', 'kakao-notify.ps1',
    'index.html', 'sbs-logo.png', 'package.json', 'package-lock.json',
    'README.md', 'app.js', 'styles.css'
  ]) {
    fs.copyFileSync(path.join(projectRoot, file), path.join(fixture, file));
  }
  const privateFiles = [
    '.env', '.env.example', '.git/config', 'server.stdout.log', 'server.stderr.log',
    'server.log', 'nested/debug.log', 'geunmupyo.db-journal', 'geunmupyo.db-wal',
    'geunmupyo.db-shm', 'geunmupyo.db.bak', 'backup.json',
    'node_modules/private-package/package.json', 'private.html'
  ];
  for (const file of privateFiles) {
    fs.mkdirSync(path.dirname(path.join(fixture, file)), { recursive: true });
    fs.writeFileSync(path.join(fixture, file), 'TEST_SENTINEL=private-fixture-only\n');
  }
  const port = await unusedPort();
  child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
    cwd: fixture,
    env: {
      ...process.env, PORT: String(port),
      NODE_PATH: path.join(projectRoot, 'node_modules'),
      SMTP_HOST: '', KAKAO_AUTOMATION: 'false'
    },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  childExit = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, output);
    try {
      if ((await request(port, '/api/state')).status === 200) { ready = true; break; }
    } catch {}
    await delay(50);
  }
  assert.ok(ready, 'Server did not start: ' + output);

  await t.test('page aliases and approval deep links serve the original HTML', async () => {
    const expected = fs.readFileSync(path.join(fixture, 'index.html'));
    for (const url of ['/', '/index', '/index.html', '/?approve=test-approval', '/index.html?approve=test']) {
      const res = await request(port, url);
      assert.equal(res.status, 200, url);
      assert.match(res.headers['content-type'], /text\/html/);
      assert.deepEqual(res.body, expected, url);
      const head = await request(port, url, 'HEAD');
      assert.equal(head.status, 200, url);
      assert.equal(head.body.length, 0);
    }
  });

  await t.test('all local resources referenced by the page remain available', async () => {
    const html = fs.readFileSync(path.join(fixture, 'index.html'), 'utf8');
    const localUrls = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
      .map(match => match[1])
      .filter(url => !/^(?:https?:|data:|#)/.test(url));
    assert.ok(localUrls.length > 0);
    for (const url of localUrls) {
      const pathname = new URL(url, 'http://localhost/').pathname;
      const res = await request(port, pathname);
      assert.equal(res.status, 200, pathname);
      assert.deepEqual(res.body, fs.readFileSync(path.join(fixture, pathname.slice(1))));
    }
    assert.match((await request(port, '/sbs-logo.png?v=1')).headers['content-type'], /image\/png/);
    assert.equal((await request(port, '/sbs-logo.png', 'HEAD')).status, 200);
  });

  await t.test('state API reads and writes the isolated database', async () => {
    const initial = await request(port, '/api/state');
    assert.equal(JSON.parse(initial.body).state, null);
    const state = { employees: [], requests: [], marker: 'disposable-test' };
    const baseRevision = JSON.parse(initial.body).revision ?? 0;
    const saved = await request(port, '/api/state', 'POST', { state, baseRevision });
    assert.equal(saved.status, 200);
    assert.equal(JSON.parse(saved.body).ok, true);
    const loaded = await request(port, '/api/state');
    assert.deepEqual(JSON.parse(loaded.body).state, state);
    assert.ok(JSON.parse(loaded.body).updatedAt);
    assert.equal((await request(port, '/api/state', 'POST', { state: [] })).status, 400);
  });

  await t.test('notification API still validates requests without sending messages', async () => {
    const res = await request(port, '/api/notify', 'POST', {});
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid notify payload');
  });

  await t.test('existing private files and unlisted files return 404 for GET and HEAD', async () => {
    for (const file of [
      ...privateFiles, 'geunmupyo.db', 'server.js', 'db.js', 'notifier.js',
      'kakao-notify.ps1', 'package.json', 'package-lock.json', 'README.md',
      'app.js', 'styles.css', 'missing-file.txt'
    ]) {
      assert.equal((await request(port, '/' + file)).status, 404, file);
      assert.equal((await request(port, '/' + file, 'HEAD')).status, 404, file);
    }
  });

  await t.test('encoded, traversing and extension-fallback paths do not expose files', async () => {
    for (const url of [
      '/%67eunmupyo.db', '/geunmupyo.db?download=1', '/server.js/',
      '/sbs-logo.png/../geunmupyo.db', '/sbs-logo.png/..%2fgeunmupyo.db',
      '/..%2fgeunmupyo.db', '/%2e%2e/geunmupyo.db', '/..%5cgeunmupyo.db',
      '//geunmupyo.db', '/private', '/%2eenv', '/%ZZ',
      '/index.html/../server.js'
    ]) {
      assert.equal((await request(port, url)).status, 404, url);
    }
  });

  await t.test('public file routes do not accept writes', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await request(port, '/index.html', method, {})).status, 404, method);
    }
  });
});
