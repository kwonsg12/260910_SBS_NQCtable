const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateSave } = require('../security');

// 관리자가 근무표 칸에 직접 넣은 휴가/대일을 직원 명의의 확정 휴가 신청으로 바꾸는 규칙.
const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name) {
  const start = script.indexOf('  function ' + name + '(');
  assert.notEqual(start, -1, name);
  const end = script.indexOf('\n  function ', start + 1);
  return script.slice(start, end < 0 ? undefined : end);
}
const date = value => new Date(value + 'T00:00:00');

// 기본 근무: a 는 1/10 일근, 1/11 야, 1/12 조 / b·c 는 그 날들 O / d 는 1/12 일근
function setup(overrides) {
  const base = {
    a: { '2099-01-10': '일', '2099-01-11': '야', '2099-01-12': '조' },
    b: { '2099-01-10': 'O', '2099-01-11': 'O', '2099-01-12': 'O' },
    c: { '2099-01-10': 'O', '2099-01-11': 'O', '2099-01-12': 'O' },
    d: { '2099-01-10': '야', '2099-01-11': '조', '2099-01-12': '일' }
  };
  const scheduleOverrides = Object.fromEntries(Object.entries(overrides).map(([key, shift]) => [key, { shift, at: 'x' }]));
  let n = 0;
  const context = vm.createContext({
    EMPLOYEES: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id })),
    STATE: { scheduleOverrides, requests: [], auditLogs: [] },
    getToday: () => date('2099-01-01'),
    getScheduleRange: () => null,
    calculatedShift: (id, day) => base[id][['2099-01-10', '2099-01-11', '2099-01-12'][day.getDate() - 10]],
    uid: () => 'id' + (++n),
    addAuditLog: (action, details) => context.STATE.auditLogs.push({ action, details })
  });
  vm.runInContext(['fmt', 'addDays', 'shiftKey', 'planManualLeaveRequests', 'convertManualLeaves'].map(source).join('\n'), context);
  return context;
}

test('일근 날 직접 넣은 휴가 + 대일은 하나의 확정 휴가 신청이 되고 수동 칸에서 빠진다', () => {
  const c = setup({ '2099-01-10::a': '휴가', '2099-01-10::b': '대일', '2099-01-11::c': '야' });
  assert.equal(c.convertManualLeaves(), 1);
  const [req] = c.STATE.requests;
  assert.equal(req.empId, 'a');
  assert.equal(req.status, 'confirmed');
  assert.equal(req.enteredBy, 'admin');
  assert.equal(req.type, 'day');
  assert.deepEqual(JSON.parse(JSON.stringify(req.chain)), [
    { date: '2099-01-10', empId: 'a', shift: '휴가', label: '휴가' },
    { date: '2099-01-10', empId: 'b', shift: '대일', label: '대일(일근 대근)' }
  ]);
  // 휴가와 상관없는 다른 날 수동 칸은 그대로 남는다.
  assert.deepEqual(Object.keys(c.STATE.scheduleOverrides), ['2099-01-11::c']);
});

test('야근·조근 이틀 휴가는 야+조 신청 하나로, 같은 대근자와 2차 대일까지 묶는다', () => {
  const c = setup({
    '2099-01-11::a': '휴가', '2099-01-12::a': '휴가',
    '2099-01-11::c': '야', '2099-01-12::c': '조',
    '2099-01-12::b': '대일'
  });
  assert.equal(c.convertManualLeaves(), 1);
  const [req] = c.STATE.requests;
  assert.equal(req.type, 'set');
  assert.equal(req.startDate, '2099-01-11');
  assert.deepEqual([...req.chain].map(e => `${e.date}/${e.empId}/${e.shift}/${e.label}`), [
    '2099-01-11/a/휴가/휴가(야)', '2099-01-12/a/휴가/휴가(조)',
    '2099-01-11/c/야/대근 투입(야)', '2099-01-12/c/조/대근 투입(조)',
    '2099-01-12/b/대일/2차 대근(연쇄)'
  ]);
  assert.deepEqual(Object.keys(c.STATE.scheduleOverrides), []);
});

test('지난 날짜와 대근자 없는 휴가: 지난 건은 그대로, 대근자 없으면 휴가만 신청으로', () => {
  const c = setup({ '2098-12-31::a': '휴가', '2099-01-10::a': '휴가' });
  assert.equal(c.convertManualLeaves(), 1);
  assert.equal(c.STATE.requests[0].chain.length, 1);
  assert.deepEqual(Object.keys(c.STATE.scheduleOverrides), ['2098-12-31::a']);
});

test('서버: 승인 담당자는 근무표만 고칠 수 있고 직원 구성·설정은 못 고친다', () => {
  const old = {
    employees: [{ id: 'a', name: 'a' }], approvers: [{ id: 'x', name: '담당' }], requests: [], protects: [], approvals: [], excuses: [],
    settings: { quotaMax: 3 }, monthlyApprovals: {}, auditLogs: [], scheduleOverrides: {}, rotationAnchors: []
  };
  const edited = structuredClone(old);
  edited.scheduleOverrides['2099-01-10::a'] = { shift: '교육', at: 'x' };
  edited.rotationAnchors.push({ id: 'r', empId: 'a', startDate: '2099-01-01', startShift: '일' });
  // 근무표 편집: 담당자 가능, 직원은 불가
  assert.doesNotThrow(() => validateSave(old, edited, false, null, true));
  assert.throws(() => validateSave(old, edited, false, 'a', false), /근무표 수동 편집/);
  // 직원 구성·설정·담당자: 담당자도 불가, 시스템 관리자만
  for (const change of [s => s.employees.push({ id: 'b', name: 'b' }), s => { s.settings.quotaMax = 5; }, s => s.approvers.push({ id: 'y', name: '새 담당' })]) {
    const next = structuredClone(old); change(next);
    assert.throws(() => validateSave(old, next, false, null, true), /시스템 관리자/);
    assert.doesNotThrow(() => validateSave(old, next, true));
  }
  // 담당자가 근무표 편집에서 직접 넣은 휴가도 직원 신청(관리자 입력)으로 저장할 수 있다.
  const leave = { ...structuredClone(old), requests: [{ id: 'r1', empId: 'a', startDate: '2099-01-10', chain: [], status: 'confirmed', enteredBy: 'admin' }] };
  assert.doesNotThrow(() => validateSave(old, leave, false, null, true));
});

test('서버: 관리자만 enteredBy=admin 확정 휴가를 넣을 수 있다', () => {
  const old = {
    employees: [{ id: 'a', name: 'a' }], approvers: [{ id: 'x', name: '담당' }], requests: [], protects: [], approvals: [], excuses: [],
    settings: { quotaMax: 3 }, monthlyApprovals: {}, auditLogs: []
  };
  const withRequest = req => ({ ...structuredClone(old), requests: [{ id: 'r1', empId: 'a', startDate: '2099-01-10', chain: [], ...req }] });
  assert.doesNotThrow(() => validateSave(old, withRequest({ status: 'confirmed', enteredBy: 'admin' }), true));
  // 관리자라도 표시 없이 확정 상태로 넣을 수는 없다(담당자가 있으면 승인 대기여야 함).
  assert.throws(() => validateSave(old, withRequest({ status: 'confirmed' }), true), /승인 결과/);
  // 직원은 관리자 입력 표시를 붙일 수 없다.
  assert.throws(() => validateSave(old, withRequest({ status: 'confirmed', enteredBy: 'admin' }), false, 'a'), /관리자 입력/);
  assert.throws(() => validateSave(old, withRequest({ status: 'pending', enteredBy: 'admin' }), true), /승인 결과/);
});
