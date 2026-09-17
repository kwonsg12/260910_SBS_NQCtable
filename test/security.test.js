const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, copyFileSync, rmSync, readFileSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const { publicState, validateSave } = require('../security');
const root = path.resolve(__dirname, '..');
const password = 'test-admin-password-only';

function seed() {
  return {
    employees: [{ id: 'e1', name: '직원' }, { id: 'e2', name: '다른 직원' }],
    approvers: [
      { id: 'a1', name: '담당', scope: 'e1', pin: '123456', email: 'one@example.invalid' },
      { id: 'a2', name: '타 담당', scope: 'e2', pin: '654321', email: 'two@example.invalid' }
    ],
    requests: [{ id: 'r1', empId: 'e1', startDate: '2026-10-01', chain: [], status: 'pending' }],
    protects: [],
    approvals: [{ id: 'p1', refId: 'r1', type: 'leave', requestedBy: 'e1', approverIds: ['a1'], title: '휴가', summary: '', status: 'pending', decidedBy: null, decidedAt: null, decisionReason: '' }],
    settings: { quotaMax: 3, adminPin: 'old-admin-secret', smtpPass: 'old-smtp-secret', kakaoKey: 'old-kakao-secret' },
    monthlyApprovals: {}, auditLogs: [], scheduleSnapshots: {},
    versions: [{ settings: { adminPin: 'nested-secret' }, approvers: [{ pin: 'nested-pin' }] }]
  };
}
async function fixture(t, initial = seed(), adminPassword = password) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nqc-security-'));
  for (const file of ['server.js', 'db.js', 'security.js', 'notifier.js', 'index.html', 'sbs-logo.png']) copyFileSync(path.join(root, file), path.join(dir, file));
  if (initial) {
    const db = new DatabaseSync(path.join(dir, 'geunmupyo.db'));
    db.exec('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
    db.prepare('INSERT INTO kv_store VALUES (?, ?, ?)').run('schedule_state', JSON.stringify(initial), new Date().toISOString());
    db.close();
  }
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true,
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: adminPassword, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', KAKAO_AUTOMATION: 'false', NODE_PATH: path.join(root, 'node_modules') },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill(); await stopped; }
    rmSync(dir, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let attempt = 0; attempt < 300; attempt++) {
    try { if ((await fetch(base + '/api/state')).ok) break; } catch {}
    if (child.exitCode !== null || attempt === 299) throw new Error(output || 'Server startup failed');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  let token = '';
  async function api(url, body, admin = false, headers = {}) {
    const response = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Admin-Token': token } : {}), ...headers },
      body: JSON.stringify(body)
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data, headers: response.headers };
  }
  async function login() {
    const response = await api('/api/auth/admin', { password });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    token = response.data.token;
  }
  async function state() { return (await api('/api/state')).data.state; }
  async function save(value, admin = false, approverPins = {}) {
    const current = (await api('/api/state')).data;
    return api('/api/state', { state: value, approverPins, baseRevision: current.revision ?? 0 }, admin);
  }
  return { api, login, state, save, dir };
}

test('legacy secrets migrate to salted hashes; API and static paths do not disclose them', async t => {
  const f = await fixture(t);
  const response = await f.api('/api/state');
  const text = JSON.stringify(response.data);
  for (const secret of ['123456', '654321', 'old-admin-secret', 'old-smtp-secret', 'old-kakao-secret', 'nested-secret', 'nested-pin']) assert.ok(!text.includes(secret), secret);
  assert.equal(response.data.state.approvers[0].pinConfigured, true);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const db = new DatabaseSync(path.join(f.dir, 'geunmupyo.db'));
  const row = db.prepare('SELECT * FROM approval_credentials WHERE id=?').get('a1');
  assert.equal(row.hash.length, 64);
  assert.notEqual(row.hash, '123456');
  const stored = db.prepare('SELECT value FROM kv_store').get().value;
  assert.ok(!stored.includes('nested-pin'));
  db.close();
  for (const url of ['/geunmupyo.db', '/.env', '/security.js', '/server.js', '/package.json', '/%67eunmupyo.db']) assert.equal((await f.api(url)).status, 404, url);
  const page = await f.api('/');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /script-src-attr 'none'/);
});

test('approval requires assigned actor AND correct PIN; decisions are atomic and cannot be replayed', async t => {
  const f = await fixture(t);
  const decide = (overrides = {}) => f.api('/api/approvals/decision', { id: 'p1', approverId: 'a1', pin: '123456', approved: true, ...overrides });
  assert.equal((await decide({ approverId: 'a2', pin: '654321' })).status, 403);
  assert.equal((await decide({ pin: 'bad' })).status, 401);
  assert.equal((await decide({ approved: false, reason: '' })).status, 400);
  const results = await Promise.all([decide(), decide()]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const state = await f.state();
  assert.equal(state.approvals[0].decidedBy, 'a1');
  assert.equal(state.approvals[0].status, 'approved');
  assert.equal(state.requests[0].status, 'confirmed');
  assert.ok(state.approvals[0].decidedAt);
  assert.equal(state.auditLogs.filter(a => a.details?.approvalId === 'p1').length, 1);
});

test('state API refuses forged results, deleted history and replaced approval targets even for admins', async t => {
  const f = await fixture(t);
  await f.login();
  for (const mutate of [
    s => { s.approvals[0].status = 'approved'; },
    s => { s.approvals[0].approverIds = ['a2']; },
    s => { s.approvals = []; },
    s => { s.requests[0].status = 'confirmed'; },
    s => { s.requests = []; },
    s => { s.monthlyApprovals['2026-10'] = { approverId: 'a1' }; }
  ]) {
    const state = await f.state(); mutate(state);
    assert.equal((await f.save(state, true)).status, 409);
  }
  assert.equal((await f.state()).requests[0].status, 'pending');
});

test('configuration and PIN changes need administrator auth; PIN changes roll back with an invalid save', async t => {
  const f = await fixture(t);
  const original = await f.state();
  assert.equal((await f.save({ ...original, settings: { quotaMax: 10 } })).status, 403);
  assert.equal((await f.save(original, false, { a1: '999999' })).status, 403);
  await f.login();
  const removed = structuredClone(original);
  removed.approvers = removed.approvers.filter(a => a.id !== 'a1');
  assert.equal((await f.save(removed, true)).status, 409);
  assert.equal((await f.save({ ...original, settings: { quotaMax: 4 } }, true)).status, 200);
  const state = await f.state();
  state.approvers.push({ id: 'a3', name: 'new', pinConfigured: true });
  assert.equal((await f.save(state, true, { a1: '999999', a3: 'short' })).status, 400);
  assert.equal((await f.api('/api/approvals/decision', { id: 'p1', approverId: 'a1', pin: '123456', approved: false, reason: '다른 일정' })).status, 200);
  assert.equal((await f.state()).requests[0].status, 'cancelled');
});

test('first save requires configured admin; password attempts and cross-site writes are rejected', async t => {
  const f = await fixture(t, null);
  const state = seed(); state.approvers = []; state.approvals = []; state.requests = []; state.versions = [];
  assert.equal((await f.save(state)).status, 403);
  for (let i = 0; i < 5; i++) assert.equal((await f.api('/api/auth/admin', { password: 'wrong' })).status, 401);
  assert.equal((await f.api('/api/auth/admin', { password })).status, 429);
  assert.equal((await f.api('/api/state', { state }, false, { Origin: 'https://other.invalid' })).status, 403);
});

test('unconfigured admin fails closed, while valid initialization stores public data only', async t => {
  const missing = await fixture(t, null, '');
  assert.equal((await missing.api('/api/auth/admin', { password })).status, 503);
  const f = await fixture(t, null);
  await f.login();
  const state = seed(); state.approvals = []; state.requests = []; state.versions = [];
  state.approvers = state.approvers.map(a => ({ ...publicState(a), pinConfigured: true }));
  assert.equal((await f.save(state, true, { a1: '123456', a2: '654321' })).status, 200);
  assert.ok(!JSON.stringify(await f.state()).includes('123456'));
});

test('new leave requests stay pending, quota is checked by server and targets cannot be forged', async t => {
  const f = await fixture(t);
  const state = await f.state();
  state.requests.push({ id: 'r2', empId: 'e1', startDate: '2026-10-03', chain: [], status: 'pending' });
  state.approvals.push({ id: 'p2', refId: 'r2', type: 'leave', requestedBy: 'e1', approverIds: ['a1'], status: 'pending' });
  assert.equal((await f.save(state)).status, 200);
  const forged = await f.state();
  forged.requests.push({ id: 'r3', empId: 'e1', startDate: '2026-10-04', chain: [], status: 'confirmed' });
  assert.equal((await f.save(forged)).status, 403);
  const quota = await f.state();
  quota.protects = Array.from({ length: 4 }, (_, i) => ({ id: 'off' + i, empId: 'e1', date: '2026-10-0' + (i + 1), status: 'approved', needsApproval: false }));
  assert.equal((await f.save(quota)).status, 403);
  const wrong = await f.state();
  wrong.approvals.push({ id: 'month', refId: '2026-10', type: 'monthly', requestedBy: null, approverIds: ['a1'], status: 'pending' });
  assert.equal((await f.save(wrong)).status, 400);
});

test('monthly and excess protection decisions update the linked record', async t => {
  const state = seed();
  state.protects.push({ id: 'off1', empId: 'e1', date: '2026-10-05', status: 'pending', needsApproval: true });
  state.approvals.push({ id: 'off-approval', type: 'protect', refId: 'off1', requestedBy: 'e1', approverIds: ['a1'], status: 'pending' });
  state.approvals.push({ id: 'month', type: 'monthly', refId: '2026-10', requestedBy: null, approverIds: ['a1', 'a2'], status: 'pending' });
  const f = await fixture(t, state);
  for (const id of ['off-approval', 'month']) assert.equal((await f.api('/api/approvals/decision', { id, approverId: 'a1', pin: '123456', approved: true })).status, 200);
  const saved = await f.state();
  assert.equal(saved.protects[0].status, 'approved');
  assert.equal(saved.monthlyApprovals['2026-10'].approverId, 'a1');
});

test('notification recipients/content are taken from stored approval, not client-supplied addresses', async t => {
  const f = await fixture(t);
  const response = await f.api('/api/notify', { approval: { id: 'p1', title: 'FORGED' }, approvers: [{ email: 'forged@example.invalid' }] });
  assert.equal(response.status, 200);
  assert.ok(!JSON.stringify(response.data).includes('forged@example.invalid'));
  assert.match(JSON.stringify(response.data), /one@example.invalid/);
  assert.equal((await f.api('/api/notify', { approval: { id: 'p1' } })).status, 429);
  assert.equal((await f.api('/api/notify', { approval: { id: '' } })).status, 400);
});

test('UI compiles and renders untrusted approval strings as text without inline handlers', () => {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  assert.ok(!html.includes('onclick='));
  const payload = '<img src=x onerror="alert(1)">\\\'';
  const nodes = { '#approvalActorSelect': { value: '' }, '#approvalList': {}, '#approvalHistory': {}, '#approverList': {} };
  const approval = { id: 'id', status: 'pending', type: 'leave', title: payload, summary: payload, approverIds: ['a'], requestedAt: new Date().toISOString() };
  const actors = [{ id: 'a', name: payload, scope: payload, email: payload, kakaoChatName: payload }];
  const context = vm.createContext({ $: selector => nodes[selector], STATE: { approvals: [approval] }, getApprovers: () => actors, pendingApprovals: () => [approval], approverName: () => payload, APPROVAL_TYPE_LABEL: { leave: '휴가' } });
  const escape = script.slice(script.indexOf('  function escapeAttribute'), script.indexOf('  function isStandardShift'));
  const render = script.slice(script.indexOf('  function renderApprovalInbox'), script.indexOf('  function addApprover'));
  vm.runInContext(escape + render + '\nrenderApprovalInbox();renderApproverAdmin();', context);
  for (const node of Object.values(nodes)) if (node.innerHTML) {
    assert.ok(!node.innerHTML.includes('<img'), node.innerHTML);
    assert.ok(node.innerHTML.includes('&lt;img'));
  }
});

test('validation rejects duplicate IDs, prototype keys and deeply nested payloads', () => {
  const old = publicState(seed()), state = structuredClone(old);
  state.approvers.push(state.approvers[0]);
  assert.throws(() => validateSave(old, state, true), /ID/);
  assert.throws(() => validateSave(old, JSON.parse('{"__proto__":{"polluted":true}}'), true), /입력 키/);
  let deep = {}; for (let i = 0; i < 30; i++) deep = { deep };
  assert.throws(() => validateSave(old, deep, true), /깊/);
});
