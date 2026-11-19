const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtempSync, copyFileSync, rmSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const root = path.resolve(__dirname, '..');
const password = 'test-admin-password-only';

// 직원 로그인(이름+PIN)과 본인 신청 취소(cancelOwn)를 실제 HTTP 서버로 검증한다.
// 패턴은 test/security.test.js의 fixture()와 동일하다.
function seed() {
  return {
    employees: [{ id: 'e1', name: '직원1' }, { id: 'e2', name: '직원2' }],
    approvers: [{ id: 'a1', name: '담당', pin: '123456', email: 'one@example.invalid' }],
    requests: [
      { id: 'r1', empId: 'e1', startDate: '2026-11-01', chain: [], status: 'pending' },
      { id: 'r2', empId: 'e2', startDate: '2026-11-02', chain: [], status: 'confirmed' }
    ],
    protects: [{ id: 'p1', empId: 'e1', date: '2026-11-05', status: 'approved', needsApproval: false },
      { id: 'p2', empId: 'e1', date: '2026-11-06', status: 'pending', needsApproval: true }],
    approvals: [{ id: 'ap1', refId: 'r1', type: 'leave', requestedBy: 'e1', approverIds: ['a1'], title: '휴가', summary: '', status: 'pending', decidedBy: null, decidedAt: null, decisionReason: '' }],
    settings: { quotaMax: 3 },
    monthlyApprovals: {}, auditLogs: [], excuses: []
  };
}

async function fixture(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nqc-employee-auth-'));
  for (const file of ['server.js', 'excel-export.js', 'my-schedule-mail.js', 'db.js', 'security.js', 'activityLog.js', 'employeeNames.js', 'backup.js', 'notifier.js', 'digest.js', 'index.html', 'sbs-logo.png']) {
    copyFileSync(path.join(root, file), path.join(dir, file));
  }
  const initial = seed();
  const db = new DatabaseSync(path.join(dir, 'geunmupyo.db'));
  db.exec('CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.prepare('INSERT INTO kv_store VALUES (?, ?, ?)').run('schedule_state', JSON.stringify(initial), new Date().toISOString());
  db.close();
  const socket = net.createServer().listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, ['server.js'], {
    cwd: dir, windowsHide: true,
    env: { ...process.env, PORT: String(port), ADMIN_PASSWORD: password, SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', NODE_PATH: path.join(root, 'node_modules') },
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
  let adminToken = '';
  async function api(url, body, headers = {}) {
    const response = await fetch(base + url, body === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: response.status, data };
  }
  async function loginAdmin() {
    const response = await api('/api/auth/admin', { password });
    assert.equal(response.status, 200, JSON.stringify(response.data));
    adminToken = response.data.token;
  }
  async function state() { return (await api('/api/state')).data.state; }
  async function setEmployeePin(empId, pin) {
    const current = (await api('/api/state')).data;
    const res = await api('/api/state', { state: current.state, baseRevision: current.revision, employeePins: { [empId]: pin } }, { 'X-Admin-Token': adminToken });
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
  async function loginEmployee(empId, pin) {
    return api('/api/auth/employee', { empId, pin });
  }
  async function cancel(kind, id, empToken) {
    return api('/api/requests/cancel', { kind, id }, { 'X-Employee-Token': empToken });
  }
  return { api, loginAdmin, state, setEmployeePin, loginEmployee, cancel };
}

test('PIN을 정하지 않은 직원은 기본 PIN 0000으로 들어와 PIN부터 바꿔야 한다', async t => {
  const f = await fixture(t);
  assert.equal((await f.loginEmployee('e1', 'anything')).status, 401);
  const first = await f.loginEmployee('e1', '0000');
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.mustChangePin, true);
  const token = first.data.token;
  // 바꾸기 전에는 직원 권한이 없다(잠금 획득·취소 모두 거부).
  assert.equal((await f.api('/api/lock/acquire', {}, { 'X-Employee-Token': token })).status, 401);
  assert.equal((await f.cancel('request', 'r1', token)).status, 401);
  // 너무 짧거나 같은 PIN은 거부, 현재 PIN이 틀려도 거부
  assert.equal((await f.api('/api/auth/employee/pin', { currentPin: '0000', newPin: '1234' }, { 'X-Employee-Token': token })).status, 400);
  assert.equal((await f.api('/api/auth/employee/pin', { currentPin: 'wrong', newPin: 'new-pin-1' }, { 'X-Employee-Token': token })).status, 401);
  assert.equal((await f.api('/api/auth/employee/pin', { currentPin: '0000', newPin: 'new-pin-1' }, { 'X-Employee-Token': token })).status, 200);
  // 같은 세션은 바로 직원 권한을 얻고, 다음 로그인부터는 새 PIN만 통한다.
  assert.equal((await f.api('/api/lock/acquire', {}, { 'X-Employee-Token': token })).status, 200);
  assert.equal((await f.loginEmployee('e1', '0000')).status, 401);
  const again = await f.loginEmployee('e1', 'new-pin-1');
  assert.equal(again.status, 200);
  assert.equal(again.data.mustChangePin, false);
});

test('직원은 로그인한 상태에서 본인 PIN을 바꿀 수 있고, 로그인 없이는 못 바꾼다', async t => {
  const f = await fixture(t);
  await f.loginAdmin();
  await f.setEmployeePin('e1', 'correct-pin-1');
  assert.equal((await f.api('/api/auth/employee/pin', { currentPin: 'correct-pin-1', newPin: 'changed-pin-1' })).status, 401);
  const login = await f.loginEmployee('e1', 'correct-pin-1');
  assert.equal(login.data.mustChangePin, false);
  assert.equal((await f.api('/api/auth/employee/pin', { currentPin: 'correct-pin-1', newPin: 'changed-pin-1' }, { 'X-Employee-Token': login.data.token })).status, 200);
  assert.equal((await f.loginEmployee('e1', 'correct-pin-1')).status, 401);
  assert.equal((await f.loginEmployee('e1', 'changed-pin-1')).status, 200);
});

test('로그인 성공/실패와 직원별 독립적인 잠금(5회)을 검증한다', async t => {
  const f = await fixture(t);
  await f.loginAdmin();
  await f.setEmployeePin('e1', 'correct-pin-1');
  await f.setEmployeePin('e2', 'correct-pin-2');

  const ok = await f.loginEmployee('e1', 'correct-pin-1');
  assert.equal(ok.status, 200);
  assert.deepEqual({ empId: ok.data.empId, name: ok.data.name }, { empId: 'e1', name: '직원1' });
  assert.ok(ok.data.token);

  for (let i = 0; i < 5; i++) assert.equal((await f.loginEmployee('e1', 'wrong')).status, 401);
  const locked = await f.loginEmployee('e1', 'correct-pin-1');
  assert.equal(locked.status, 429);

  // e1이 잠긴 동안에도 e2 로그인은 영향받지 않는다(직원별 독립 잠금 키).
  const otherOk = await f.loginEmployee('e2', 'correct-pin-2');
  assert.equal(otherOk.status, 200);
});

test('본인 소유 휴가 신청을 취소하면 상태가 바뀌고 연결된 대기 승인도 정리된다', async t => {
  const f = await fixture(t);
  await f.loginAdmin();
  await f.setEmployeePin('e1', 'correct-pin-1');
  const login = await f.loginEmployee('e1', 'correct-pin-1');
  const res = await f.cancel('request', 'r1', login.data.token);
  assert.equal(res.status, 200);
  const state = await f.state();
  const request = state.requests.find(r => r.id === 'r1');
  assert.equal(request.status, 'cancelled');
  assert.ok(request.cancelledAt);
  const approval = state.approvals.find(a => a.id === 'ap1');
  assert.equal(approval.status, 'rejected');
  assert.equal(approval.decidedBy, null);
  assert.equal(approval.decisionReason, '신청자 본인 취소');
  assert.equal(state.approvals.filter(a => a.status === 'pending').length, 0);
});

test('타인 명의 취소, 비로그인 취소, 이미 처리된 건 취소는 모두 거부된다', async t => {
  const f = await fixture(t);
  await f.loginAdmin();
  await f.setEmployeePin('e1', 'correct-pin-1');
  await f.setEmployeePin('e2', 'correct-pin-2');
  const asE2 = await f.loginEmployee('e2', 'correct-pin-2');

  // e2가 e1의 신청을 취소하려 하면 거부된다.
  assert.equal((await f.cancel('request', 'r1', asE2.data.token)).status, 403);
  // 로그인 없이 취소하려 하면 거부된다.
  assert.equal((await f.cancel('request', 'r1', '')).status, 401);

  assert.equal((await f.cancel('request', 'r2', asE2.data.token)).status, 409);

  const asE1 = await f.loginEmployee('e1', 'correct-pin-1');
  assert.equal((await f.cancel('request', 'r1', asE1.data.token)).status, 200);
  // 이미 취소된 건을 다시 취소하려 하면 거부된다.
  assert.equal((await f.cancel('request', 'r1', asE1.data.token)).status, 409);
});

test('승인 대기 비번 보장만 본인이 취소할 수 있다', async t => {
  const f = await fixture(t);
  await f.loginAdmin();
  await f.setEmployeePin('e1', 'correct-pin-1');
  const login = await f.loginEmployee('e1', 'correct-pin-1');
  assert.equal((await f.cancel('protect', 'p1', login.data.token)).status, 409);
  const res = await f.cancel('protect', 'p2', login.data.token);
  assert.equal(res.status, 200);
  const state = await f.state();
  assert.equal(state.protects.find(p => p.id === 'p1').status, 'approved');
  assert.equal(state.protects.find(p => p.id === 'p2').status, 'cancelled');
});

test('관리자가 employeePins로 설정한 PIN은 평문으로 노출되지 않는다', async t => {
  const f = await fixture(t);
  await f.loginAdmin();
  await f.setEmployeePin('e1', 'super-secret-pin');
  const state = await f.state();
  assert.equal(state.employees.find(e => e.id === 'e1').pinConfigured, true);
  assert.ok(!JSON.stringify(state).includes('super-secret-pin'));
  const login = await f.loginEmployee('e1', 'super-secret-pin');
  assert.equal(login.status, 200);
});

test('승인 담당자로 로그인하면 그 담당자 이름의 승인은 PIN을 다시 묻지 않는다', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/auth/approver', { approverId: 'a1', pin: 'wrong-pin' })).status, 401);
  assert.equal((await f.api('/api/auth/approver', { approverId: 'nobody', pin: '123456' })).status, 400);
  const login = await f.api('/api/auth/approver', { approverId: 'a1', pin: '123456' });
  assert.equal(login.status, 200, JSON.stringify(login.data));
  assert.equal(login.data.name, '담당');
  // 토큰 없이 PIN도 없으면 거부, 담당자 토큰이 있으면 PIN 없이 처리된다.
  assert.equal((await f.api('/api/approvals/decision', { id: 'ap1', approverId: 'a1', approved: true })).status, 400);
  const decided = await f.api('/api/approvals/decision', { id: 'ap1', approverId: 'a1', approved: true }, { 'X-Approver-Token': login.data.token });
  assert.equal(decided.status, 200, JSON.stringify(decided.data));
  assert.equal((await f.state()).approvals.find(a => a.id === 'ap1').status, 'approved');
});
