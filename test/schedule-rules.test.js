const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name) {
  const start = script.indexOf('  function ' + name + '(');
  assert.notEqual(start, -1, name);
  const end = script.indexOf('\n  function ', start + 1);
  return script.slice(start, end < 0 ? undefined : end);
}
const functions = ['fmt', 'addDays', 'empName', 'isEmployeeActiveOnDate',
  'isActiveProtection', 'isProtectedOn', 'findByBaseShift', 'substituteNote', 'buildChain',
  'protectCountInMonth', 'requestHorizonError', 'protectionRequestError', 'confirmChain', 'submitProtect'];
const d0 = '2099-01-31', d1 = '2099-02-01';
const date = value => new Date(value + 'T00:00:00');
function setup() {
  const shifts = { a: ['야', '조'], b: ['O', '일'], c: ['일', 'O'], d: ['조', '야'] };
  const fields = { '#proReason': { value: '', focus() {} }, '#proReasonWrap': {}, '#modalConfirm': {} };
  let saves = 0;
  const context = vm.createContext({
    EMPLOYEES: Object.keys(shifts).map(id => ({ id, name: id, routine: true, startDate: '2099-01-01' })),
    STATE: { requests: [], protects: [], settings: { quotaMax: 3 } },
    employeeId: 'b', pendingChain: null, pendingProtection: { empId: 'b', dateKey: d0 }, alerts: [], approvals: [],
    getToday: () => date('2099-01-01'),
    isRoutineWorker: employee => employee.routine !== false,
    effectiveShift: (id, day) => shifts[id]?.[day.getMonth() === 0 ? 0 : 1],
    $: selector => fields[selector],
    uid: () => 'request' + saves,
    getApprovers: () => [],
    notify() {}, renderAll() {}, showToast() {}, requestError: message => context.alerts.push(message),
    closeScheduleRequest: () => { context.pendingChain = null; context.pendingProtection = null; }, saveState: () => saves++, requireEmployeeLogin: () => true,
    createApproval: value => context.approvals.push(value)
  });
  context.alert = message => context.alerts.push(message);
  vm.runInContext(functions.map(source).join('\n'), context);
  return { c: context, shifts, fields, saves: () => saves, build: () => context.buildChain('a', 'set', date(d0)) };
}

test('inline application script compiles', () => { new vm.Script(script); });
test('normal night/morning chain covers the displaced day shift across a month boundary', () => {
  const { build } = setup();
  const result = build();
  assert.equal(result.chain.length, 5);
  assert.equal(result.chain[4].empId, 'c');
  assert.equal(result.chain[4].date, d1);
  assert.equal(result.chain[4].shift, '대일');
});
test('day leave still assigns a routine off-duty substitute', () => {
  const { c, shifts } = setup(); shifts.a = ['일', 'O'];
  assert.equal(c.buildChain('a', 'day', date(d0)).chain[1].empId, 'b');
});
test('상일근(교대 4명이 아닌 사람)의 일근 휴가는 대근자 없이 휴가만 들어간다', () => {
  const { c, shifts } = setup(); shifts.a = ['일', 'O'];
  c.EMPLOYEES.find(e => e.id === 'a').routine = false;
  const result = c.buildChain('a', 'day', date(d0));
  assert.equal(result.error, undefined);
  assert.equal(result.chain.length, 1);
  assert.equal(result.chain[0].empId, 'a');
  assert.equal(result.chain[0].shift, '휴가');
  // 일근이 아닌 날은 상일근이어도 일근 휴가를 낼 수 없다.
  assert.match(c.buildChain('a', 'day', date(d1)).error, /일근인 날짜/);
});
test('next-day protection, employment end and occupied shifts exclude a night substitute', () => {
  for (const change of [
    f => f.c.STATE.protects.push({ empId: 'b', date: d1, status: 'pending' }),
    f => f.c.STATE.protects.push({ empId: 'b', date: d1, status: 'approved' }),
    f => { f.c.EMPLOYEES.find(e => e.id === 'b').endDate = d0; },
    ...['휴가', '야', '조', '교육', '대일'].map(shift => f => { f.shifts.b[1] = shift; })
  ]) {
    const f = setup(); change(f);
    assert.ok(f.build().error);
    assert.equal(f.c.STATE.requests.length, 0);
  }
});
test('an unavailable first candidate does not hide a valid later candidate', () => {
  const f = setup(); f.shifts.d = ['O', 'O'];
  f.c.STATE.protects.push({ empId: 'b', date: d1, status: 'pending' });
  const result = f.build();
  assert.equal(result.chain[2].empId, 'd');
  assert.equal(result.chain.length, 4);
});
test('day-specific protection and employment are checked separately for each substitute', () => {
  const f = setup(); f.shifts.c[1] = '교육'; f.shifts.d = ['O', 'O'];
  f.c.EMPLOYEES.find(e => e.id === 'c').routine = false;
  // d can cover b's day shift, so protect d on day one to verify the normal secondary path first.
  f.c.STATE.protects.push({ empId: 'd', date: d0, status: 'approved' });
  assert.equal(f.build().chain[4].empId, 'd');
  // With d itself selected first, no secondary replacement is necessary.
  f.c.STATE.protects = [];
  f.c.EMPLOYEES.find(e => e.id === 'd').startDate = d0;
  f.c.EMPLOYEES.find(e => e.id === 'b').endDate = d0;
  assert.equal(f.build().chain[2].empId, 'd');
});
test('protected or non-routine secondary substitutes cannot be assigned', () => {
  for (const change of [
    f => f.c.STATE.protects.push({ empId: 'c', date: d1, status: 'pending' }),
    f => { f.c.EMPLOYEES.find(e => e.id === 'c').routine = false; },
    f => { f.c.EMPLOYEES.find(e => e.id === 'c').endDate = d0; }
  ]) { const f = setup(); change(f); assert.ok(f.build().error); }
});
test('applicant must have both active night and morning shifts', () => {
  for (const change of [
    f => { f.shifts.a[1] = '휴가'; },
    f => { f.c.EMPLOYEES[0].endDate = d0; }
  ]) {
    const f = setup(); change(f);
    assert.ok(f.build().error);
  }
});
test('invalid, past and inactive request dates are rejected', () => {
  const { c } = setup();
  assert.ok(c.buildChain('a', 'other', date(d0)).error);
  assert.ok(c.buildChain('a', 'set', new Date('invalid')).error);
  assert.ok(c.buildChain('a', 'set', date('2098-12-31')).error);
  assert.ok(c.buildChain('missing', 'set', date(d0)).error);
});
test('근무표 칸 신청도 오늘부터 92일까지만 받는다', () => {
  const { c } = setup();
  // getToday는 2099-01-01이므로 92일째는 2099-04-02, 93일째는 2099-04-03이다.
  assert.equal(c.requestHorizonError(date('2099-04-02')), '');
  assert.match(c.requestHorizonError(date('2099-04-03')), /92일/);
  assert.match(c.buildChain('a', 'set', date('2099-04-03')).error, /92일/);
  assert.match(c.protectionRequestError('b', date('2099-04-03')), /92일/);
});
test('rejected/cancelled protection frees the day and quota; legacy duplicates count once', () => {
  const { c } = setup();
  c.STATE.protects = [
    { empId: 'b', date: d0, status: 'rejected' },
    { empId: 'b', date: d0, status: 'cancelled' },
    { empId: 'b', date: '2099-01-20', status: 'approved' },
    { empId: 'b', date: '2099-01-20', status: 'approved' },
    { empId: 'b', date: '2099-01-21', status: 'pending' },
    { empId: 'b', date: d1, status: 'approved' },
    { empId: 'a', date: '2099-01-22', status: 'approved' }
  ];
  assert.equal(c.protectCountInMonth('b', 2099, 0), 2);
  assert.equal(c.isProtectedOn('b', date(d0)), false);
  assert.equal(c.protectionRequestError('b', date(d0)), '');
});
test('confirming protection twice cannot create two requests', () => {
  const f = setup(); f.c.submitProtect(); f.c.submitProtect();
  assert.equal(f.c.STATE.protects.length, 1);
  assert.equal(f.saves(), 1);
  assert.equal(f.c.pendingProtection, null);
});
test('protection validates past dates, inactive employees and non-off-duty shifts before saving', () => {
  for (const change of [
    f => { f.c.pendingProtection.dateKey = '2098-12-31'; },
    f => { f.c.EMPLOYEES[1].startDate = d1; },
    f => { f.c.EMPLOYEES[1].endDate = '2099-01-30'; },
    f => { f.shifts.b[0] = '교육'; }
  ]) {
    const f = setup(); change(f); f.c.submitProtect();
    assert.equal(f.saves(), 0);
    assert.equal(f.c.STATE.protects.length, 0);
  }
});
test('quota overflow creates a pending request only with a reason', () => {
  const f = setup(); f.c.STATE.settings.quotaMax = 1;
  f.c.STATE.protects.push({ empId: 'b', date: '2099-01-20', status: 'approved' });
  f.c.submitProtect(); assert.equal(f.saves(), 0);
  f.fields['#proReason'].value = '개인 일정';
  f.c.submitProtect();
  assert.equal(f.c.STATE.protects[1].status, 'pending');
  assert.equal(f.c.approvals.length, 1);
});
test('a changed preview is not silently confirmed and successful confirmation is single-use', () => {
  const f = setup(); f.c.employeeId = 'a';
  f.c.pendingChain = { empId: 'a', type: 'set', startDate: d0, chain: f.build().chain };
  f.shifts.d = ['O', 'O'];
  f.c.STATE.protects.push({ empId: 'b', date: d1, status: 'pending' });
  assert.equal(f.build().chain[2].empId, 'd');
  f.c.confirmChain();
  assert.equal(f.saves(), 0);
  assert.equal(f.c.pendingChain, null);
  f.c.STATE.protects = [];
  f.c.pendingChain = { empId: 'a', type: 'set', startDate: d0, chain: f.build().chain };
  f.c.confirmChain(); f.c.confirmChain();
  assert.equal(f.c.STATE.requests.length, 1);
  assert.equal(f.saves(), 1);
});
