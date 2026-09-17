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
  for (const file of ['server.js', 'db.js', 'notifier.js', 'index.html']) {
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
  child = spawn(process.execPath, [path.join(fixture, 'server.js')], {
    cwd: fixture, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(port), NODE_PATH: path.join(root, 'node_modules'), SMTP_HOST: '', KAKAO_AUTOMATION: 'false' }
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
  const post = async body => {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  return { get, post, fixture };
}

test('two clients cannot overwrite each other, including first-ever saves', async t => {
  const { get, post } = await start(t);
  const a = await get(), b = await get();
  assert.equal(a.revision, 0);
  assert.equal(b.state, null);
  const results = await Promise.all([
    post({ state: { notes: 'A' }, baseRevision: a.revision }),
    post({ state: { notes: 'B' }, baseRevision: b.revision })
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = await get();
  assert.equal(saved.revision, 1);
  assert.equal(saved.state.notes, results[0].status === 200 ? 'A' : 'B');
  const retry = await post({ state: { notes: 'new edit after refresh' }, baseRevision: saved.revision });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.revision, 2);
  const stale = await post({ state: { notes: 'old tab' }, baseRevision: 1 });
  assert.equal(stale.status, 409);
  assert.equal((await get()).state.notes, 'new edit after refresh');
});

test('old clients and invalid revisions are rejected without modifying state', async t => {
  const { get, post } = await start(t);
  assert.equal((await post({ state: { notes: 'old client' } })).status, 428);
  for (const baseRevision of [null, -1, 0.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal((await post({ state: {}, baseRevision })).status, 400);
  }
  assert.equal((await post({ state: [], baseRevision: 0 })).status, 400);
  assert.equal((await get()).revision, 0);
  assert.equal((await get()).state, null);
});

test('existing databases gain a revision while preserving their saved data', async t => {
  const { get, post } = await start(t, true);
  const existing = await get();
  assert.deepEqual(existing.state, { notes: 'legacy' });
  assert.equal(existing.updatedAt, '2026-09-01');
  assert.equal(existing.revision, 1);
  assert.equal((await post({ state: { notes: 'upgraded' }, baseRevision: 1 })).status, 200);
  assert.equal((await get()).revision, 2);
});

test('separate SQLite connections use the same atomic revision check', async t => {
  const { get, post, fixture } = await start(t, true);
  const old = await get();
  const other = new DatabaseSync(path.join(fixture, 'geunmupyo.db'));
  other.prepare('UPDATE kv_store SET value = ?, revision = revision + 1 WHERE key = ?')
    .run(JSON.stringify({ notes: 'other process' }), 'schedule_state');
  other.close();
  assert.equal((await post({ state: { notes: 'stale browser' }, baseRevision: old.revision })).status, 409);
  assert.equal((await get()).state.notes, 'other process');
});
