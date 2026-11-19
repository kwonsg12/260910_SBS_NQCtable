// 관리자 편집 세션: 근무표 편집 패널의 변경은 모아 두었다가 [최종 저장] 때 한 번에 저장하고,
// [모두 취소]하면 편집 전으로 돌아간다. 편집 중 다른 곳에서 저장해도 확인 안 한 편집은 서버로 가지 않는다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function source(name) {
  const match = new RegExp('\\n  (?:async )?function ' + name + '\\(').exec(script);
  assert.notEqual(match, null, name);
  const boundary = /\n  (?:async )?function |\n  \/\/ ── /g;
  boundary.lastIndex = match.index + 2;
  const next = boundary.exec(script);
  return script.slice(match.index + 1, next ? next.index : undefined);
}
function block(startText, endText) {
  const start = script.indexOf(startText);
  const end = script.indexOf(endText, start);
  assert.ok(start >= 0 && end > start, startText);
  return script.slice(start, end + endText.length);
}

const names = ['saveState', 'cloneValue', 'beginEditSession', 'editSessionDirty', 'saveEditorChange', 'isEditDraftLog',
  'stateWithoutEditDraft', 'withEditBaseline', 'monthKeysBetween', 'monthKeysFrom', 'editSessionSummary',
  'commitEditSession', 'discardEditSession', 'addAuditLog', 'monthlySnapshot', 'monthlySnapshotDiff'];

function setup() {
  const enqueued = [];
  let ids = 0;
  const c = vm.createContext({
    STATE: {
      employees: [{ id: 'a', name: '최도인', startDate: '2026-01-01' }], employeeOrderHistory: [], rotationAnchors: [],
      deletedEmployeesTrash: [], scheduleOverrides: {}, scheduleRanges: [], scheduleSnapshots: {},
      auditLogs: [{ id: 'old', action: '수동 근무 편집' }], approvals: [], monthlyApprovals: {}, versions: [],
      settings: { stationName: '관제실', notes: '' }
    },
    LOCAL_MODE: false, DEFAULT_STATION_NAME: '관제실', versionRecords: 0,
    stateSync: { enqueue: state => enqueued.push(JSON.parse(JSON.stringify(state))) },
    recordMonthlyVersionChanges() { c.versionRecords++; },
    getActiveStaff: () => c.EMPLOYEES, isEmployeeActiveOnDate: () => true,
    getShiftForDate: (empId, date) => c.STATE.scheduleOverrides[`${empId}_${date.getDate()}`]?.shift || '일',
    getApprovalLines: () => [], fmt: d => d.toISOString().slice(0, 10), getToday: () => new Date('2026-12-01T00:00:00Z'),
    uid: () => 'log' + ++ids, $: () => ({ hidden: true }),
    renderEditSessionBar() {}, renderAll() {}, showToast() {}, populateEmpSelects() {}, renderManualEmployeeOptions() {},
    settingsEmployeeEditor: { open() {} }, renderEndedStaffList() {}, renderDeletedStaffTrash() {}, renderScheduleEditor() {},
    pendingScheduleRanges: [], pendingBulkFills: [], scheduleEditorEdits: {}
  });
  c.EMPLOYEES = c.STATE.employees;
  vm.runInContext(block('  const EDIT_SESSION_KEYS', 'let editSessionExpiryWarned = false;') + '\n' + names.map(source).join('\n'), c);
  const session = () => vm.runInContext('editSession', c);
  // 편집 패널에서 12월 3일 칸을 고친 것과 같은 변경
  const editCell = () => {
    c.STATE.scheduleOverrides['a_3'] = { shift: '휴가' };
    c.addAuditLog('수동 근무 편집', { empId: 'a', date: '2026-12-03' });
    c.saveEditorChange('근무 칸 직접 수정 1칸', ['2026-12']);
  };
  return { c, enqueued, session, editCell };
}

test('편집 세션 밖에서는 예전처럼 바로 저장한다', () => {
  const { c, enqueued } = setup();
  c.saveEditorChange('x');
  assert.equal(enqueued.length, 1);
});

test('세션 중 변경은 저장하지 않고, 다른 곳에서 저장해도 확인 안 한 편집은 빼고 보낸다', () => {
  const { c, enqueued, editCell } = setup();
  c.beginEditSession();
  editCell();
  assert.equal(enqueued.length, 0);
  assert.equal(c.editSessionDirty(), true);
  // 예: 편집 도중 담당자 설정을 저장
  c.STATE.settings.quotaMax = 5;
  c.saveState();
  assert.equal(enqueued.length, 1);
  assert.deepEqual(enqueued[0].scheduleOverrides, {});
  assert.deepEqual(enqueued[0].auditLogs.map(log => log.id), ['old']);
  assert.equal(enqueued[0].settings.quotaMax, 5);
  assert.equal(c.versionRecords, 0, '확정 이후 변경 이력은 편집이 확정될 때 기록한다');
  // 화면(STATE)에는 편집이 그대로 남아 미리보기로 보인다.
  assert.equal(c.STATE.scheduleOverrides['a_3'].shift, '휴가');
});

test('요약은 바뀐 칸을 "전 → 후"로 보여 주고, 확정된 달을 알려 준다', () => {
  const { c, editCell } = setup();
  c.STATE.monthlyApprovals['2026-12'] = { approverName: '담당' };
  c.beginEditSession();
  editCell();
  const summary = c.editSessionSummary();
  assert.deepEqual([...summary.notes], ['근무 칸 직접 수정 1칸']);
  assert.equal(summary.diffs.length, 1);
  assert.equal(summary.diffs[0].label, '최도인 · 2026-12-03');
  assert.equal(summary.diffs[0].before, '일');
  assert.equal(summary.diffs[0].after, '휴가');
  assert.deepEqual([...summary.confirmedMonths], ['2026-12']);
  // 요약을 만드는 동안 잠시 바꾼 기준본이 STATE 에 남지 않는다.
  assert.equal(c.STATE.scheduleOverrides['a_3'].shift, '휴가');
  assert.equal(c.EMPLOYEES, c.STATE.employees);
});

test('[최종 저장]은 한 번에 저장하고 기록을 남긴다', () => {
  const { c, enqueued, session, editCell } = setup();
  c.beginEditSession();
  editCell();
  c.commitEditSession(c.editSessionSummary());
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].scheduleOverrides['a_3'].shift, '휴가');
  assert.equal(enqueued[0].auditLogs[0].action, '관리자 편집 저장');
  assert.equal(c.versionRecords, 1);
  assert.equal(session(), null);
});

test('[모두 취소]는 편집 전 값으로 되돌리고 편집 기록도 지운다', () => {
  const { c, enqueued, session, editCell } = setup();
  c.beginEditSession();
  editCell();
  c.EMPLOYEES = [...c.EMPLOYEES, { id: 'new', name: '테스트' }];
  c.STATE.employees = c.EMPLOYEES;
  c.saveEditorChange('직원 구성 편집', ['2026-12']);
  c.discardEditSession();
  assert.equal(JSON.stringify(c.STATE.scheduleOverrides), '{}');
  assert.equal(JSON.stringify(c.STATE.employees.map(e => e.id)), '["a"]');
  assert.equal(c.EMPLOYEES, c.STATE.employees);
  assert.equal(JSON.stringify(c.STATE.auditLogs.map(log => log.id)), '["old"]');
  assert.equal(enqueued.length, 0);
  assert.equal(session(), null);
});

test('달 범위: 기간이면 그 사이 달, 시작점이면 시작 달부터 3개월', () => {
  const { c } = setup();
  assert.deepEqual([...c.monthKeysBetween('2026-11-20', '2027-01-05')], ['2026-11', '2026-12', '2027-01']);
  assert.deepEqual([...c.monthKeysFrom('2026-12-15')], ['2026-12', '2027-01', '2027-02']);
});
