const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const root = path.resolve(__dirname, '..');

async function start(t, legacy = false) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nqc-sync-test-'));
  let child, exited;
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (exited) await exited;
    assert.equal(path.dirname(path.resolve(fixture)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(fixture).startsWith('nqc-sync-test-'));
    fs.rmSync(fixture, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  for (const file of ['server.js', 'db.js', 'security.js', 'notifier.js', 'digest.js', 'index.html', 'sbs-logo.png']) {
    fs.copyFileSync(path.join(root, file), path.join(fixture, file));
  }
  if (legacy) {
    const db = new DatabaseSync(path.join(fixture, 'geunmupyo.db'));
    db.exec('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO kv_store VALUES (?, ?, ?)').run('schedule_state', JSON.stringify({ notes: 'legacy' }), '2026-09-01');
    db.close();
  }
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const adminPassword = 'test-admin-password-only';
  child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NODE_PATH: path.join(root, 'node_modules'), SMTP_HOST: '', ADMIN_PASSWORD: adminPassword }
  });
  exited = once(child, 'exit');
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const url = 'http://127.0.0.1:' + port + '/api/state';
  let ready = false;
  for (let i = 0; i < 100; i++) {
    assert.equal(child.exitCode, null, output);
    try { const res = await fetch(url); await res.arrayBuffer(); if (res.status === 200) { ready = true; break; } } catch {}
    await delay(50);
  }
  assert.ok(ready, output);
  const get = async () => {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return res.json();
  };
  let token = '';
  const login = async () => {
    const res = await fetch('http://127.0.0.1:' + port + '/api/auth/admin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: adminPassword })
    });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    token = data.token;
  };
  // 담당자·직원·설정 등 보호된 항목의 검증/권한 확인은 security.test.js가 전담하므로,
  // 이 파일은 항상 관리자 토큰으로 요청해 순수 버전(revision) 충돌 처리만 검증한다.
  const post = async body => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Token': token }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { get, post, login, fixture };
}

test('two clients cannot overwrite each other, including first-ever saves', async t => {
  const { get, post, login } = await start(t);
  await login();
  const a = await get(), b = await get();
  assert.equal(a.revision, 0);
  assert.equal(b.state, null);
  const results = await Promise.all([
    post({ state: { settings: { quotaMax: 3 }, notes: 'A' }, baseRevision: a.revision }),
    post({ state: { settings: { quotaMax: 3 }, notes: 'B' }, baseRevision: b.revision })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = await get();
  assert.equal(saved.revision, 1);
  assert.equal(saved.state.notes, results[0].status === 200 ? 'A' : 'B');
  const retry = await post({ state: { settings: { quotaMax: 3 }, notes: 'new edit after refresh' }, baseRevision: saved.revision });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.revision, 2);
  const stale = await post({ state: { settings: { quotaMax: 3 }, notes: 'old tab' }, baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await get()).state.notes, 'new edit after refresh');
});

test('old clients and invalid revisions are rejected without modifying state', async t => {
  const { get, post, login } = await start(t);
  await login();
  const created = await post({ state: { settings: { quotaMax: 3 }, notes: 'base' }, baseRevision: 0 });
  assert.equal(created.status, 200);
  assert.equal(created.data.revision, 1);
  // baseRevision을 생략하거나 서버의 실제 버전과 다르면(문자열/소수/범위 밖 값 포함) 충돌로 거부된다.
  for (const baseRevision of [undefined, null, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1, 0, 2]) {
    const res = await post({ state: { settings: { quotaMax: 3 }, notes: 'old client' }, baseRevision });
    assert.equal(res.status, 409, JSON.stringify({ baseRevision, res }));
  }
  assert.equal((await post({ state: [], baseRevision: 1 })).status, 400);
  assert.equal((await get()).revision, 1);
  assert.equal((await get()).state.notes, 'base');
});

test('existing databases gain a revision while preserving their saved data', async t => {
  const { get, post, login } = await start(t, true);
  await login();
  // 서버가 시작할 때 담당자/직원 PIN 설정 여부 표시를 위해 approvers·employees 필드를 한 번
  // 채워 넣고(같은 트랜잭션 안이라 저장은 한 번만 일어난다) 그만큼 버전을 올린다.
  const existing = await get();
  assert.deepEqual(existing.state, { notes: 'legacy', approvers: [], employees: [] });
  assert.equal(existing.revision, 2);
  const upgraded = await post({ state: { notes: 'upgraded', settings: { quotaMax: 3 }, approvers: [] }, baseRevision: existing.revision });
  assert.equal(upgraded.status, 200);
  assert.equal((await get()).revision, 3);
});

test('separate SQLite connections use the same atomic revision check', async t => {
  const { get, post, fixture, login } = await start(t, true);
  await login();
  const old = await get();
  const other = new DatabaseSync(path.join(fixture, 'geunmupyo.db'));
  other.prepare('UPDATE kv_store SET value = ?, revision = revision + 1 WHERE key = ?')
    .run(JSON.stringify({ notes: 'other process' }), 'schedule_state');
  other.close();
  assert.equal((await post({ state: { notes: 'stale browser' }, baseRevision: old.revision })).status, 409);
  assert.equal((await get()).state.notes, 'other process');
});
