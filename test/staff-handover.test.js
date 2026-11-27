const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { validateSave } = require('../security');

const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name) {
  const start = script.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, name);
  const firstLine = script.indexOf('\n', start);
  if (script.slice(start, firstLine).trimEnd().endsWith('}')) return script.slice(start, firstLine);
  return script.slice(start, script.indexOf('\n  }', start) + 4);
}
const functions = ['fmt', 'stripTime', 'addDays', 'dateInRange', 'dayIndex', 'workTypeChangesOf', 'activeWorkTypeChange', 'workTypeAt',
  'isDispatchedDayWorker', 'dispatchedNameKey', 'dayWorkerName', 'isRoutineWorker', 'workTypeOf', 'staffOrderDate', 'getOrderedEmployeeIds', 'getActiveStaff',
  'isEmployeeActiveOnDate', 'getRotationAnchorFor', 'rotationShift', 'getHolidayInfo', 'isWeekendOrHoliday', 'baseShift', 'shiftKey', 'isPastDate',
  'getScheduleRange', 'findChainAssignment', 'calculatedShift', 'getShiftForDate', 'effectiveShift', 'snapshotHistoricalSchedule', 'bulkFillValueFor',
  'wtOrderFor', 'wtRoutineIds', 'wtRoutineNames', 'staffEventIds', 'staffEventList', 'staffEventsFor', 'staffEventUndoError', 'removeStaffEventData',
  'withStaffEventRemoved', 'staffAdaptationPeriods', 'staffNeedsOnboarding', 'staffImpact', 'staffAffectedMonths', 'wtPlan', 'wtApply', 'cancelStaffEvent'];
const json = value => JSON.parse(JSON.stringify(value));
function fixture({ extra = true, history = true } = {}) {
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : ['2026-11-27T12:00:00'])); }
    static now() { return new FixedDate().getTime(); }
  }
  const employees = ['a', 'b', 'c', 'd'].map((id, phase) => ({ id, name: id, phase, workType: 'NC', startDate: '2026-01-01' }));
  employees.push({ id: 'tc', name: 'TC', phase: 0, workType: 'TC', startDate: '2026-01-01' },
    { id: 'dispatch', name: '파견', workType: 'dispatch', startDate: '2026-01-01' });
  if (extra) employees.push({ id: 'new', name: '신규', workType: 'NC', onboarding: true, startDate: '2026-12-01', phase: 0 });
  const state = { employees, settings: { quotaMax: 3 }, approvers: [], requests: [], protects: [], approvals: [], excuses: [],
    employeeOrderHistory: history ? [{ month: '2026-01', order: employees.map(e => e.id) }] : [], rotationAnchors: [],
    scheduleOverrides: {}, scheduleSnapshots: {}, scheduleRanges: [], auditLogs: [], monthlyApprovals: {}, versions: [] };
  let ids = 0;
  const c = vm.createContext({ Date: FixedDate, EMPLOYEES: employees, STATE: state, ROUTINE_HEADCOUNT: 4,
    WORK_TYPES: ['NC', 'TC', 'dispatch'], CYCLE: ['일', '야', '조', 'O'], DEFAULT_DAY_WORKER_NAME: '파견', ANCHOR: new FixedDate(2026, 7, 1),
    COMPANY_HOLIDAYS: { '2026-12-24': '창립기념일' }, FIXED_PUBLIC_HOLIDAYS: { '12-25': '성탄절' }, LUNAR_HOLIDAYS: {}, stateHolidayMap: {},
    getToday: () => new FixedDate(), uid: () => `test_${++ids}`, empName: id => c.EMPLOYEES.find(e => e.id === id)?.name || id,
    pendingBulkFills: [], pendingScheduleRanges: [], scheduleEditorEdits: {}, cloneValue: v => v === undefined ? undefined : json(v),
    addAuditLog: (action, details) => state.auditLogs.unshift({ id: `log_${++ids}`, action, details, at: new FixedDate().toISOString() }),
    monthKeysFrom: from => [from.slice(0, 7)], saveEditorChange() {}, requireScheduleEditor: () => true, confirm: () => true,
    alert: m => { throw Error(m); }, renderAll() {}, renderManualEmployeeOptions() {}, populateEmpSelects() {},
    renderScheduleEditor() {}, settingsEmployeeEditor: { open() {} }
  });
  vm.runInContext(functions.map(source).join('\n'), c);
  const date = key => new FixedDate(`${key}T00:00:00`);
  const emp = id => c.EMPLOYEES.find(e => e.id === id);
  const routine = key => json(c.wtRoutineIds(c.EMPLOYEES, c.wtOrderFor(key), key));
  const type = (id, key) => c.workTypeAt(emp(id), key);
  const shift = (id, key) => c.getShiftForDate(id, date(key));
  const plan = (id, target, key, partner, action = 'TC', fresh = null) => c.wtPlan(emp(id), target, key, partner, '일', fresh, action);
  return { c, state, date, emp, routine, type, shift, plan };
}

test('월 이력과 날짜 이력이 호환되고 다음 변경일까지 순서가 유지된다', () => {
  const { c, state, date, routine } = fixture();
  state.employeeOrderHistory.push({ from: '2026-12-15', order: ['d', 'c', 'b', 'a', 'tc'] },
    { month: '2027-02', order: ['b', 'a', 'c', 'd'] });
  assert.deepEqual(routine('2026-12-14'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(routine('2026-12-15'), ['d', 'c', 'b', 'a']);
  assert.deepEqual(routine('2027-01-30'), ['d', 'c', 'b', 'a']);
  assert.deepEqual(routine('2027-02-01'), ['b', 'a', 'c', 'd']);
  assert.ok(!c.getActiveStaff(2026, 10, date('2026-11-30')).some(e => e.id === 'new'));
  assert.ok(c.getActiveStaff(2026, 11, date('2026-12-01')).some(e => e.id === 'new'));
  assert.deepEqual(json(c.getActiveStaff(2026, 11).slice(0, 4).map(e => e.id)), ['a', 'b', 'c', 'd']);
});

test('기존 NC 퇴출 경로: TC와 자리·사이클을 날짜부터 인계하고 양쪽에서 같은 이벤트를 취소한다', () => {
  const { c, state, emp, routine, type, shift, plan, date } = fixture();
  const when = '2026-12-10', before = c.rotationShift(emp('a'), date(when));
  const p = plan('a', 'TC', when, 'tc');
  assert.equal(p.error, '');
  assert.ok(c.wtApply(p));
  assert.deepEqual(routine('2026-12-09'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(routine(when), ['tc', 'b', 'c', 'd']);
  assert.deepEqual(routine('2027-01-05'), ['tc', 'b', 'c', 'd']);
  assert.equal(type('a', '2026-12-09'), 'NC');
  assert.equal(type('a', when), 'TC');
  assert.equal(type('tc', when), 'NC');
  assert.equal(shift('tc', when), before);
  const event = c.staffEventsFor('tc')[0];
  assert.equal(event.id, c.staffEventsFor('a')[0].id);
  assert.equal(state.rotationAnchors[0].eventId, event.id);
  assert.ok(c.cancelStaffEvent(event));
  assert.deepEqual(routine(when), ['a', 'b', 'c', 'd']);
  assert.equal(type('a', when), 'NC');
  assert.equal(type('tc', when), 'TC');
  assert.equal(state.rotationAnchors.length, 0);
  assert.equal(state.staffHandoverEvents.length, 0);
});

test('근무 형태가 없는 이전 직원 데이터도 조회일의 NC/TC 구분으로 인계할 수 있다', () => {
  const { c, emp, plan, date, routine } = fixture();
  for (const id of ['a','b','c','d','tc']) delete emp(id).workType;
  assert.equal(c.workTypeOf(emp('a'), date('2026-12-01')), 'NC');
  assert.equal(c.workTypeOf(emp('tc'), date('2026-12-01')), 'TC');
  const p = plan('tc', 'NC', '2026-12-10', 'a');
  assert.equal(p.error, '');
  c.wtApply(p);
  assert.deepEqual(routine('2026-12-10'), ['tc','b','c','d']);
  c.cancelStaffEvent(c.staffEventsFor('tc')[0]);
  assert.equal(emp('tc').workType, undefined);
});

test('신규 적응 직원 경로: 전출 연동, 기간/사이클 인계, 날짜 수정과 복구가 한 번에 적용된다', () => {
  const { c, state, emp, routine, type, shift, plan, date } = fixture();
  emp('new').adaptationPeriods = [{ id: 'adapt', empId: 'new', startDate: '2026-12-01', endDate: '2026-12-09', pattern: ['일'], holidayOff: true }];
  assert.equal(shift('new', '2026-12-05'), 'O');
  assert.equal(shift('new', '2026-12-07'), '일');
  assert.match(plan('new', 'NC', '2026-12-09', 'b', 'transfer').error, /적응기간/);
  const p = plan('new', 'NC', '2026-12-10', 'b', 'transfer');
  assert.equal(p.error, '');
  assert.equal(p.event.incomingId, 'new');
  assert.equal(p.event.outgoingId, 'b');
  c.wtApply(p);
  assert.equal(emp('b').endDate, '2026-12-09');
  assert.equal(c.isEmployeeActiveOnDate(emp('b'), date('2026-12-10')), false);
  assert.deepEqual(routine('2026-12-10'), ['a', 'new', 'c', 'd']);
  assert.equal(shift('new', '2026-12-10'), c.rotationShift(emp('b'), date('2026-12-10')));
  const old = c.staffEventsFor('b')[0];
  const p2 = c.withStaffEventRemoved(old, () => plan('new', 'NC', '2026-12-20', 'c', 'TC'));
  assert.equal(p2.error, '');
  assert.equal(emp('b').endDate, '2026-12-09', '미리보기는 저장 상태를 건드리지 않는다');
  c.wtApply(p2, old);
  assert.equal(emp('b').endDate, null);
  assert.equal(type('c', '2026-12-20'), 'TC');
  assert.deepEqual(routine('2026-12-19'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(routine('2026-12-20'), ['a', 'b', 'new', 'd']);
  assert.equal(c.staffEventsFor('b').length, 0);
  assert.equal(c.staffEventsFor('new').length, 1);
  c.cancelStaffEvent(c.staffEventsFor('c')[0]);
  assert.equal(emp('new').onboarding, true);
  assert.equal(emp('new').soloDeployment, undefined);
  assert.equal(emp('new').adaptationPeriods.length, 1);
  assert.deepEqual(routine('2026-12-20'), ['a', 'b', 'c', 'd']);
});

test('기존 NC에서 새 사람 직접 등록 가능: 시작일과 단독 투입일 분리 및 취소 시 신규 등록 보존', () => {
  const { c, emp, plan, routine, shift } = fixture({ extra: false, history: false });
  const p = plan('d', 'transfer', '2026-12-15', '__new__', 'transfer', { id: 'fresh', name: '새 사람', email: 'new@example.invalid', startDate: '2026-12-01' });
  assert.equal(p.error, '');
  c.wtApply(p);
  assert.equal(emp('fresh').startDate, '2026-12-01');
  assert.equal(shift('fresh', '2026-12-05'), 'O');
  assert.deepEqual(routine('2026-12-14'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(routine('2026-12-15'), ['a', 'b', 'c', 'fresh']);
  c.cancelStaffEvent(c.staffEventsFor('fresh')[0]);
  assert.ok(emp('fresh'));
  assert.equal(emp('d').endDate, null);
  assert.deepEqual(routine('2026-12-15'), ['a', 'b', 'c', 'd']);
});

test('다른 직원들의 독립된 미래 인계는 서로 취소해도 순서·앵커가 보존된다', () => {
  const { c, state, routine, plan } = fixture();
  c.wtApply(plan('a', 'TC', '2026-12-10', 'tc'));
  const p2 = plan('b', 'TC', '2026-12-20', 'new');
  assert.equal(p2.error, '');
  c.wtApply(p2);
  assert.deepEqual(routine('2026-12-20'), ['tc', 'new', 'c', 'd']);
  c.cancelStaffEvent(c.staffEventsFor('a')[0]);
  assert.deepEqual(routine('2026-12-20'), ['a', 'new', 'c', 'd']);
  assert.equal(state.rotationAnchors.length, 1);
  assert.equal(c.staffEventsFor('new').length, 1);
});

test('중복 인계·적응기간·교대 사이클을 차단하며 4명 미만은 명확한 경고 대상이다', () => {
  const { c, emp, routine, plan } = fixture();
  assert.match(plan('new', 'NC', '2026-12-15', '').error, /기존 NC/);
  assert.match(plan('tc', 'NC', '2026-12-15', '').error, /4명이 배정/);
  assert.match(plan('a', 'TC', '2026-12-15', 'b').error, /중복/);
  assert.match(plan('a', 'TC', '2026-12-15', '__new__', 'TC', { id: 'another', name: '신규', startDate: '2026-12-15' }).error, /이미 등록/);
  c.wtApply(plan('a', 'TC', '2026-12-15', 'tc'));
  assert.match(plan('a', 'TC', '2026-12-13', 'new').error, /다른 인계/);
  assert.match(plan('new', 'NC', '2026-12-13', 'a').error, /다른 인계/);
  c.cancelStaffEvent(c.staffEventsFor('a')[0]);
  const vacancy = plan('a', 'TC', '2026-12-15', '');
  assert.equal(vacancy.error, '');
  assert.equal(vacancy.routineAfter.length, 3);
  c.wtApply(vacancy);
  assert.deepEqual(routine('2026-12-15'), ['b', 'c', 'd']);
  assert.equal(emp('new').soloDeployment, undefined);
});

test('TC가 빈 교대 자리를 채울 때 기존 사이클과 겹치는 시작 근무는 차단한다', () => {
  const { c, emp, plan, date } = fixture();
  const from = '2026-12-15';
  // 이미 NC 1명은 전출한 상태다. 다른 세 교대의 시작 근무가 중복되면 안 된다.
  emp('a').endDate = '2026-12-14';
  const occupied = c.rotationShift(emp('b'), date(from));
  const vacant = c.rotationShift(emp('a'), date(from));
  assert.match(c.wtPlan(emp('tc'), 'NC', from, '', occupied).error, /사이클이 중복/);
  assert.equal(c.wtPlan(emp('tc'), 'NC', from, '', vacant).error, '');
});

test('휴일 O는 기본 근무에만 적용되고 회사 휴일·법정휴일·명시적 기록·과거 스냅샷이 모두 보존된다', () => {
  const { c, state, shift, plan } = fixture();
  state.scheduleOverrides['2026-12-24::a'] = { shift: '수동', at: '2026-11-27T00:00:00Z' };
  state.requests.push({ id: 'leave', empId: 'a', status: 'approved', submittedAt: '2026-11-26T00:00:00Z', chain: [{ empId: 'a', date: '2026-12-25', shift: '휴가' }] });
  state.scheduleSnapshots['2026-11-01::a'] = '과거';
  state.monthlyApprovals['2026-12'] = { versionId: 'old' };
  state.versions.push({ id: 'old', kind: 'monthly-approved' });
  const p = plan('a', 'TC', '2026-12-10', 'tc');
  assert.deepEqual(json(p.confirmed), ['2026-12']);
  assert.equal(p.covers.length, 1);
  assert.equal(p.manual, 1);
  c.wtApply(p);
  assert.equal(shift('a', '2026-12-12'), 'O');
  assert.equal(shift('dispatch', '2026-12-24'), 'O');
  assert.equal(shift('dispatch', '2026-12-25'), 'O');
  assert.equal(shift('a', '2026-12-24'), '수동');
  assert.equal(shift('a', '2026-12-25'), '휴가');
  assert.equal(shift('a', '2026-11-01'), '과거');
  assert.equal(state.versions.length, 1);
  c.cancelStaffEvent(c.staffEventsFor('a')[0]);
  assert.equal(shift('a', '2026-12-24'), '수동');
  assert.equal(shift('a', '2026-12-25'), '휴가');
  assert.equal(shift('a', '2026-11-01'), '과거');
});

test('이전 월별 인계의 감사 로그가 일치하면 안전하게 취소하고 불명확한 이력은 차단한다', () => {
  const { c, state, emp, routine } = fixture();
  const from = '2026-12-10', at = '2026-11-27T00:00:00Z';
  const changes = [{ empId: 'a', from, workType: 'TC', at }, { empId: 'tc', from, workType: 'NC', at }];
  for (const { empId, ...change } of changes) emp(empId).workTypeChanges = [change];
  const anchor = { id: 'old_anchor', empId: 'tc', startDate: from, startShift: '일', at, inheritFrom: 'a' };
  state.rotationAnchors.push(anchor);
  state.employeeOrderHistory.push({ month: '2026-12', order: ['tc', 'b', 'c', 'd', 'a', 'dispatch', 'new'] });
  state.auditLogs.push({ id: 'old_log', at, action: '직원 구성 편집', details: { from, orderMonth: '2026-12', workTypeChange: changes, anchors: [anchor] } });
  const event = c.staffEventsFor('a')[0];
  assert.equal(c.staffEventUndoError(event), '');
  assert.equal(c.staffEventsFor('tc')[0].id, event.id);
  state.employeeOrderHistory[1].order.reverse();
  assert.match(c.staffEventUndoError(c.staffEventsFor('a')[0]), /겹쳐/);
  state.employeeOrderHistory[1].order.reverse();
  c.cancelStaffEvent(c.staffEventsFor('tc')[0]);
  assert.deepEqual(routine(from), ['a', 'b', 'c', 'd']);
});

test('이미 시작된 인계는 수정/취소할 수 없다', () => {
  const { c, plan } = fixture();
  c.wtApply(plan('a', 'TC', '2026-11-27', 'tc'));
  assert.match(c.staffEventUndoError(c.staffEventsFor('a')[0]), /이미 시작/);
});

test('서버는 순서·인계 권한 및 연결 원자성, 미래 기록 취소, 과거 기록 불변성을 검증한다', () => {
  const { c, state, plan } = fixture();
  const baseline = json(state);
  const p = plan('new', 'NC', '2026-12-15', 'a', 'transfer');
  c.wtApply(p);
  // 서버 실제 날짜에 관계없이 유효한 미래 이벤트가 되도록 전체 연결 날짜를 이동한다.
  const linked = json(state);
  const event = linked.staffHandoverEvents[0];
  event.from = '2099-12-15';
  linked.rotationAnchors[0].startDate = event.from;
  linked.employeeOrderHistory.at(-1).from = event.from;
  linked.employees.find(e => e.id === 'a').endDate = '2099-12-14';
  linked.employees.find(e => e.id === 'new').soloDeployment.from = event.from;
  assert.doesNotThrow(() => validateSave(baseline, linked, true));
  assert.throws(() => validateSave(baseline, { ...baseline, employeeOrderHistory: linked.employeeOrderHistory }, false, 'a'), e => e.status === 403);
  assert.throws(() => validateSave(baseline, { ...baseline, staffHandoverEvents: linked.staffHandoverEvents }, false, 'a'), e => e.status === 403);
  assert.throws(() => validateSave(baseline, { ...linked, rotationAnchors: [] }, true), /연결/);
  assert.throws(() => validateSave(linked, { ...linked, staffHandoverEvents: [] }, true), /연결/);
  assert.doesNotThrow(() => validateSave(linked, baseline, true));
  const past = json(linked); past.staffHandoverEvents[0].from = '2000-01-01';
  assert.throws(() => validateSave(past, baseline, true), /이미 시작/);
});

test('직원 구성 불러오기/날짜 조회 및 인계 양쪽 UI가 연결되어 있다', () => {
  assert.match(html, /id="staffEffectiveDate"/);
  assert.match(script, /loadScheduleEditMonthBtn[^\n]+settingsEmployeeEditor\.load\(\)/);
  assert.match(script, /staffEffectiveDate[^\n]+addEventListener\('change'/);
  assert.match(script, /staffEventControls\(staffEventsFor\(row\.id\)/);
  assert.match(script, /staffNeedsOnboarding\(row, viewDate\)/);
  assert.match(script, /openWorkTypeDialog\(empId, \{ onboarding: true, from: startDate, partnerId: ref \}\)/);
});
