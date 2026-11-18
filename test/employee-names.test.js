// 완전 삭제된 직원의 이름이 지난 기록(화면·활동 로그·요약 메일)에서 id 로 바뀌지 않는지 확인한다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { employeeName, formerEmployeeName } = require('../employeeNames');
const { validateSave } = require('../security');

const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name) {
  const start = script.indexOf('  function ' + name + '(');
  assert.notEqual(start, -1, name);
  const end = script.indexOf('\n  function ', start + 1);
  return script.slice(start, end < 0 ? undefined : end);
}

const deletedLog = { id: 'log1', action: '직원 완전 삭제', details: { employee: { id: 'id_old', name: '권승기', email: 'x@y.z' } }, at: '2026-11-01T00:00:00Z' };

test('서버: 재직자 → 이름, 이름표·휴지통·관리자 기록 순으로 삭제된 직원 이름을 찾는다', () => {
  const state = { employees: [{ id: 'e1', name: '최도인' }], formerEmployees: [{ id: 'f1', name: '이름표' }],
    deletedEmployeesTrash: [{ id: 't1', name: '휴지통' }], auditLogs: [deletedLog] };
  assert.equal(employeeName(state, 'e1'), '최도인');
  assert.equal(employeeName(state, 'f1'), '이름표(삭제됨)');
  assert.equal(employeeName(state, 't1'), '휴지통(삭제됨)');
  // 이름표가 생기기 전에 삭제된 직원(실제 권승기 사례)도 관리자 기록에서 이름이 돌아온다.
  assert.equal(employeeName(state, 'id_old'), '권승기(삭제됨)');
  assert.equal(employeeName(state, 'nobody'), '알 수 없음');
  assert.equal(employeeName(state, 'nobody', 'nobody'), 'nobody');
  assert.equal(formerEmployeeName({}, 'x'), '');
});

test('화면: empName 이 삭제된 직원을 id 대신 이름(삭제됨)으로 표시한다', () => {
  const context = vm.createContext({
    EMPLOYEES: [{ id: 'e1', name: '최도인' }],
    STATE: { auditLogs: [deletedLog], formerEmployees: [{ id: 'f1', name: '테스트' }] }
  });
  vm.runInContext(['formerEmployeeName', 'empName'].map(source).join('\n'), context);
  assert.equal(context.empName('e1'), '최도인');
  assert.equal(context.empName('id_old'), '권승기(삭제됨)');
  assert.equal(context.empName('f1'), '테스트(삭제됨)');
  assert.equal(context.empName('nobody'), 'nobody');
});

test('완전 삭제가 이름표를 남기고, 복구하면 이름표에서 뺀다', () => {
  const context = vm.createContext({
    EMPLOYEES: [{ id: 'e1', name: '최도인' }, { id: 'e2', name: '권승기', endDate: '2026-10-30' }],
    STATE: { rotationAnchors: [], deletedEmployeesTrash: [], auditLogs: [] },
    requireAdmin: () => true, saveState() {}, populateEmpSelects() {}, renderManualEmployeeOptions() {},
    settingsEmployeeEditor: { open() {} }, renderEndedStaffList() {}, renderDeletedStaffTrash() {}, renderAll() {},
    uid: () => 'u' + Math.random().toString(36).slice(2)
  });
  vm.runInContext(['addAuditLog', 'hardDeleteEmployee', 'restoreDeletedEmployee', 'formerEmployeeName', 'empName'].map(source).join('\n'), context);
  context.hardDeleteEmployee('e2');
  assert.equal(JSON.stringify(context.STATE.formerEmployees.map(e => [e.id, e.name])), JSON.stringify([['e2', '권승기']]));
  assert.equal(context.empName('e2'), '권승기(삭제됨)');
  context.restoreDeletedEmployee(0);
  assert.equal(context.STATE.formerEmployees.length, 0);
  assert.equal(context.empName('e2'), '권승기');
});

test('이름표(formerEmployees)는 관리자만 바꿀 수 있다', () => {
  const base = { employees: [{ id: 'e1', name: 'A' }], approvers: [], requests: [], protects: [], approvals: [], excuses: [], settings: { quotaMax: 3 } };
  const forged = { ...base, formerEmployees: [{ id: 'x', name: '가짜' }] };
  assert.throws(() => validateSave(base, forged, false, 'e1'), e => e.status === 403);
  assert.doesNotThrow(() => validateSave(base, forged, true));
  // 키가 아예 없는 예전 상태에 근무자가 저장해도(키 없음 그대로) 막히지 않는다.
  assert.doesNotThrow(() => validateSave(base, { ...base }, false, 'e1'));
});
