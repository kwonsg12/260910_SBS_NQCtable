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
  'isDispatchedDayWorker', 'dispatchedNameKey', 'dayWorkerName', 'rotationRoleAt', 'isRoutineWorker', 'workTypeOf', 'staffOrderDate', 'getOrderedEmployeeIds', 'getActiveStaff',
  'isEmployeeActiveOnDate', 'getRotationAnchorFor', 'rotationShift', 'getHolidayInfo', 'isWeekendOrHoliday', 'baseShift', 'shiftKey', 'isPastDate',
  'getScheduleRange', 'findChainAssignment', 'calculatedShift', 'getShiftForDate', 'effectiveShift', 'snapshotHistoricalSchedule', 'bulkFillValueFor',
  'wtOrderFor', 'wtRoutineIds', 'wtRoutineNames', 'staffEventIds', 'staffEventList', 'staffEventsFor', 'staffEventUndoError', 'legacyAnchorMatches',
  'legacyRepairOptions', 'prepareLegacyRepair', 'removeStaffEventData',
  'withStaffEventRemoved', 'staffAdaptationPeriods', 'staffNeedsOnboarding', 'staffImpact', 'staffAffectedMonths', 'wtPlan', 'wtApply', 'cancelStaffEvent',
  'isRotationAnchorLinked', 'setStandaloneRotationAnchor', 'removeRotationAnchor'];
const json = value => JSON.parse(JSON.stringify(value));
function fixture({ extra = true, history = true } = {}) {
  let today = '2026-11-27';
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [today + 'T12:00:00'])); }
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
    renderScheduleEditor() {}, renderRotationAnchorList(){}, renderRotationAnchorPreview(){}, renderManualRotationPreview(){}, showToast(){}, settingsEmployeeEditor: { open() {} }
  });
  vm.runInContext(functions.map(source).join('\n'), c);
  const date = key => new FixedDate(`${key}T00:00:00`);
  const emp = id => c.EMPLOYEES.find(e => e.id === id);
  const routine = key => json(c.wtRoutineIds(c.EMPLOYEES, c.wtOrderFor(key), key));
  const type = (id, key) => c.workTypeAt(emp(id), key);
  const shift = (id, key) => c.getShiftForDate(id, date(key));
  const plan = (id, target, key, partner, action = 'TC', fresh = null) => c.wtPlan(emp(id), target, key, partner, '일', fresh, action);
  return { c, state, date, emp, routine, type, shift, plan, setToday: key => { today = key; } };
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
  assert.equal(plan('tc', 'NC', '2026-12-15', '').error, '');
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

test('새 교대 자리는 기존 근무와 겹쳐도 추가 인원으로 등록하며 자동대근 공백을 메우지 않는다', () => {
  const { c, emp, date, routine, shift } = fixture();
  const from = '2026-12-15';
  // 이미 NC 1명은 전출한 상태다. 새 자리는 추가 인원이므로 빈 자동대근 자리에 들어가지 않는다.
  emp('a').endDate = '2026-12-14';
  const occupied = c.rotationShift(emp('b'), date(from));
  const vacant = c.rotationShift(emp('a'), date(from));
  const p = c.wtPlan(emp('tc'), 'NC', from, '', occupied);
  assert.equal(p.error, '');
  assert.equal(c.wtPlan(emp('tc'), 'NC', from, '__extra__', vacant).error, '');
  c.wtApply(p);
  assert.equal(c.rotationRoleAt(emp('tc'), from),'extra');
  assert.deepEqual(routine(from),['b','c','d']);
  assert.equal(shift('tc',from),occupied);
  assert.equal(c.isRoutineWorker(emp('tc'), date(from)),false);
});

test('자동대근 4명이 모두 있어도 추가 교대 등록 가능, 순서를 올리거나 공백이 생겨도 제외', () => {
  const { c, state, emp, plan, routine, shift, type, date } = fixture();
  const from = '2026-12-10', p = plan('tc','NC',from,'__extra__');
  assert.equal(p.error,''); assert.equal(p.event.placement,'extra'); assert.equal(p.routineAfter.length,4);
  c.wtApply(p);
  assert.equal(type('tc','2026-12-09'),'TC');
  assert.equal(type('tc',from),'NC');
  assert.equal(shift('tc',from),'일'); assert.equal(shift('tc','2026-12-11'),'야');
  state.employeeOrderHistory.push({from:'2026-12-12',order:['tc','a','b','c','d','new','dispatch']});
  assert.deepEqual(routine('2026-12-12'),['a','b','c','d']);
  emp('a').endDate='2026-12-14';
  assert.deepEqual(routine('2026-12-15'),['b','c','d']);
  assert.equal(c.isRoutineWorker(emp('tc'),date('2026-12-15')),false);
  assert.equal(c.staffNeedsOnboarding(emp('tc'),'2026-12-15'),false);
});

test('신규 적응 직원도 추가 교대 투입 가능하고 이후 정식 자리 인계만 자동대근으로 전환한다', () => {
  const {c, emp, plan, routine, shift, setToday} = fixture();
  const p=plan('new','NC','2026-12-05','__extra__');
  assert.equal(p.error,''); c.wtApply(p);
  assert.equal(emp('new').soloDeployment.from,'2026-12-05');
  assert.equal(shift('new','2026-12-06'),'야');
  assert.equal(c.staffNeedsOnboarding(emp('new'),'2026-12-06'),false);
  assert.deepEqual(routine('2026-12-06'),['a','b','c','d']);
  setToday('2026-12-07');
  const handover=plan('new','NC','2026-12-15','a');
  assert.equal(handover.error,''); assert.equal(handover.event.placement,'routine'); c.wtApply(handover);
  assert.equal(c.rotationRoleAt(emp('new'),'2026-12-14'),'extra');
  assert.equal(c.rotationRoleAt(emp('new'),'2026-12-15'),'routine');
  assert.deepEqual(routine('2026-12-15'),['new','b','c','d']);
  c.cancelStaffEvent(c.staffEventsFor('new').find(e=>e.from==='2026-12-15'));
  assert.equal(c.rotationRoleAt(emp('new'),'2026-12-15'),'extra');
  assert.deepEqual(routine('2026-12-15'),['a','b','c','d']);
});

test('예정 추가 교대 수정·취소는 역할 이력과 교대 시작점도 함께 복구한다', () => {
  const {c, state, emp, plan, type, routine}=fixture();
  c.wtApply(plan('tc','NC','2026-12-05','__extra__'));
  const old=c.staffEventsFor('tc')[0];
  const updated=c.withStaffEventRemoved(old,()=>plan('tc','NC','2026-12-10','__extra__'));
  assert.equal(updated.error,'');c.wtApply(updated,old);
  assert.equal(c.rotationRoleAt(emp('tc'),'2026-12-05'),null);
  assert.equal(c.rotationRoleAt(emp('tc'),'2026-12-10'),'extra');
  assert.equal(state.rotationAnchors.length,1);
  c.cancelStaffEvent(c.staffEventsFor('tc')[0]);
  assert.equal(emp('tc').rotationRoleChanges,undefined);assert.equal(type('tc','2026-12-10'),'TC');
  assert.deepEqual(routine('2026-12-10'),['a','b','c','d']);
});

test('교대 루틴 보정은 지정일부터 반복하며 기존 휴가·수동·과거 기록과 다음 보정은 유지한다', () => {
  const {c,state,shift,routine}=fixture();
  state.scheduleSnapshots['2026-11-01::a']='과거';
  state.scheduleOverrides['2026-12-02::a']={shift:'수동',at:'2026-11-01'};
  state.requests.push({id:'r',empId:'a',status:'approved',submittedAt:'2026-11-01',chain:[{empId:'a',date:'2026-12-03',shift:'휴가'}]});
  const set=(startDate,startShift)=>c.setStandaloneRotationAnchor({empId:'a',startDate,startShift},{staffOnly:true,replace:true});
  assert.ok(set('2026-12-01','일'));
  assert.deepEqual(['2026-12-01','2026-12-02','2026-12-03','2026-12-04','2026-12-05'].map(d=>shift('a',d)),['일','수동','휴가','O','일']);
  assert.ok(set('2026-12-10','야'));
  assert.equal(shift('a','2026-12-10'),'야');
  assert.ok(set('2026-12-10','조'));
  assert.equal(state.rotationAnchors.length,2);assert.equal(shift('a','2026-12-10'),'조');
  assert.ok(c.removeRotationAnchor(state.rotationAnchors.find(a=>a.startDate==='2026-12-10').id,{staffOnly:true}));
  assert.equal(shift('a','2026-12-10'),'야');assert.equal(shift('a','2026-11-01'),'과거');
  assert.deepEqual(routine('2026-12-10'),['a','b','c','d']);
});

test('추가 교대 루틴 보정은 자동대근 역할을 바꾸지 않고 과거 날짜·상일근·예정 인계는 거절한다', () => {
  const {c,emp,plan,shift,routine,setToday}=fixture();
  const set=(id,startDate)=>c.setStandaloneRotationAnchor({empId:id,startDate,startShift:'일'},{staffOnly:true,replace:true});
  assert.throws(()=>set('a','2026-11-26'),/오늘 이후/);
  assert.throws(()=>set('tc','2026-12-01'),/재직 NC/);
  c.wtApply(plan('tc','NC','2026-12-01','__extra__'));
  assert.throws(()=>set('tc','2026-12-10'),/예정된 교대 인계/);
  setToday('2026-12-05');
  assert.ok(set('tc','2026-12-10'));
  assert.equal(shift('tc','2026-12-10'),'일');assert.equal(shift('tc','2026-12-11'),'야');
  assert.equal(c.rotationRoleAt(emp('tc'),'2026-12-10'),'extra');
  assert.deepEqual(routine('2026-12-10'),['a','b','c','d']);
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

function overlappingLegacyFixture() {
  const f = fixture();
  const { state, emp } = f;
  const at = '2026-11-26T00:00:00Z', from = '2026-12-10', secondFrom = '2026-12-15';
  const first = [{empId:'a', from, workType:'TC', at}, {empId:'tc', from, workType:'NC', at}];
  const second = [{empId:'b', from:secondFrom, workType:'TC', at}];
  delete emp('new').onboarding;
  for (const {empId, ...change} of [...first, ...second]) emp(empId).workTypeChanges = [change];
  const firstAnchor = {id:'old_a', empId:'tc', startDate:from, startShift:'야', at, inheritFrom:'a'};
  const secondAnchor = {id:'old_b', empId:'new', startDate:secondFrom, startShift:'조', at, inheritFrom:'b'};
  state.rotationAnchors.push(firstAnchor, secondAnchor);
  state.employeeOrderHistory.push({month:'2026-12', order:['tc','new','c','d','a','dispatch','b']});
  state.auditLogs.push({id:'legacy_a', at, action:'직원 구성 편집', details:{from, orderMonth:'2026-12', workTypeChange:first, anchors:[firstAnchor]}},
    {id:'legacy_b', at, action:'직원 구성 편집', details:{from:secondFrom, orderMonth:'2026-12', workTypeChange:second, anchors:[secondAnchor]}});
  return f;
}

test('같은 달에 겹친 이전 인계는 관련 직원 순서만 복구하고 다른 인계와 과거 기록은 보존한다', () => {
  const { c, state, emp, type, routine } = overlappingLegacyFixture();
  state.scheduleSnapshots['2026-11-01::a'] = '보존';
  state.scheduleOverrides['2026-12-24::a'] = {shift:'수동',at:'2026-11-20'};
  const event = c.staffEventsFor('a')[0];
  assert.equal(event.legacy.ambiguous, true);
  assert.match(c.staffEventUndoError(event), /겹쳐/);
  const choices = c.legacyRepairOptions(event);
  assert.deepEqual(json(choices.current), ['tc','new','c','d','a','dispatch','b']);
  assert.deepEqual(json(choices.restored), ['a','new','c','d','tc','dispatch','b']);
  assert.equal(choices.suggestion, 'restore');
  const repaired = c.prepareLegacyRepair(event, 'restore');
  assert.equal(c.staffEventUndoError(repaired), '');
  assert.ok(c.cancelStaffEvent(repaired));
  assert.equal(type('a','2026-12-20'), 'NC');
  assert.equal(type('tc','2026-12-20'), 'TC');
  assert.equal(type('b','2026-12-20'), 'TC');
  assert.equal(state.rotationAnchors.length, 1);
  assert.equal(state.rotationAnchors[0].id,'old_b');
  assert.deepEqual(routine('2026-12-20'), ['a','new','c','d']);
  assert.ok(state.employeeOrderHistory.some(e => e.month === '2026-12'), '기존 월별 기록을 지우지 않는다');
  assert.equal(state.scheduleSnapshots['2026-11-01::a'],'보존');
  assert.equal(state.scheduleOverrides['2026-12-24::a'].shift,'수동');
  assert.equal(c.staffEventsFor('a').length,0);
  assert.equal(c.staffEventsFor('b').length,1);
});

test('겹친 이전 인계 복구 후 새 날짜로 수정하면 같은 날짜의 새 인계 순서가 복구 순서 다음으로 적용된다', () => {
  const { c, state, plan, routine } = overlappingLegacyFixture();
  const event = c.prepareLegacyRepair(c.staffEventsFor('a')[0], 'restore');
  const p = c.withStaffEventRemoved(event, () => plan('a', 'TC', '2026-12-01', 'tc'));
  assert.equal(p.error, '');
  assert.ok(c.wtApply(p, event));
  assert.deepEqual(routine('2026-12-01'), ['tc','new','c','d']);
  assert.equal(state.rotationAnchors.some(a => a.id === 'old_b'), true);
  assert.equal(state.staffHandoverEvents[0].from,'2026-12-01');
});

test('현재 순서를 선택하면 겹친 월별 이력과 일치하지 않는 로테이션은 수정하지 않는다', () => {
  const { c, state, type } = overlappingLegacyFixture();
  state.rotationAnchors[0] = {...state.rotationAnchors[0], startShift:'O'};
  const before = json(state.employeeOrderHistory);
  const event = c.prepareLegacyRepair(c.staffEventsFor('a')[0], 'keep');
  assert.equal(c.staffEventUndoError(event), '');
  assert.ok(c.cancelStaffEvent(event));
  assert.deepEqual(json(state.employeeOrderHistory), before);
  assert.equal(state.rotationAnchors.find(a => a.id==='old_a').startShift,'O');
  assert.equal(type('a','2026-12-20'),'NC');
  assert.equal(type('b','2026-12-20'),'TC');
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
  linked.employees.find(e => e.id === 'new').rotationRoleChanges[0].from = event.from;
  assert.doesNotThrow(() => validateSave(baseline, linked, true));
  assert.throws(() => validateSave(baseline, { ...baseline, employeeOrderHistory: linked.employeeOrderHistory }, false, 'a'), e => e.status === 403);
  assert.throws(() => validateSave(baseline, { ...baseline, staffHandoverEvents: linked.staffHandoverEvents }, false, 'a'), e => e.status === 403);
  assert.throws(() => validateSave(baseline, { ...linked, rotationAnchors: [] }, true), /연결/);
  assert.throws(() => validateSave(linked, { ...linked, staffHandoverEvents: [] }, true), /연결/);
  const disconnected = json(linked); delete disconnected.employees.find(e=>e.id==='new').rotationRoleChanges;
  assert.throws(() => validateSave(baseline, disconnected, true), /역할/);
  assert.doesNotThrow(() => validateSave(linked, baseline, true));
  const past = json(linked); past.staffHandoverEvents[0].from = '2000-01-01';
  assert.throws(() => validateSave(past, baseline, true), /이미 시작/);
});

test('직원 구성 날짜별 불러오기는 월 근무표와 독립적이며 인계 양쪽 UI가 연결되어 있다', () => {
  assert.match(html, /id="staffEffectiveDate"/);
  assert.match(html, /class="edit-month" data-for-view="cells"/);
  assert.match(html, /class="staff-date-controls" data-for-view="staff"/);
  assert.match(script, /loadScheduleEditMonthBtn[^\n]+renderScheduleEditor/);
  assert.match(script, /loadStaffDateBtn[^\n]+settingsEmployeeEditor\.load\(\$\('#staffEffectiveDate'\)\.value\)/);
  assert.match(script, /staffEffectiveDate[^\n]+addEventListener\('change'[^\n]+updateDateStatus/);
  assert.match(script, /staffEventControls\(staffEventsFor\(row\.id\)/);
  assert.match(script, /staffNeedsOnboarding\(row, viewDate\)/);
  assert.match(script, /openWorkTypeDialog\(empId, \{ onboarding: true, from: startDate, partnerId: ref \}\)/);
  assert.match(script, /event\.legacy\?\.ambiguous\) openLegacyRepairDialog/);
});
