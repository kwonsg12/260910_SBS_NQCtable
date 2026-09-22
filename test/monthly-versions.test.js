const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

// 실제 서버(decide())로 넘어가는 async 호출은 아래 mock securityRequest가 대신하며,
// security.js의 monthly 확정 로직을 그대로 흉내낸다. 서버 쪽 로직 자체의 정확성은
// test/security.test.js와 test/state-api.test.js가 실제 HTTP 요청으로 검증한다.
function source(name){
  const re = new RegExp('\\n  (?:async )?function ' + name + '\\(');
  const match = re.exec(script);
  assert.notEqual(match, null, name);
  const start = match.index + 1;
  const boundary = /\n  (?:async )?function /g;
  boundary.lastIndex = start + 1;
  const next = boundary.exec(script);
  return script.slice(start, next ? next.index : undefined);
}
const names = ['monthKeyOf', 'monthlySnapshot', 'monthlySnapshotDiff', 'approvedMonthlyVersion',
  'monthlyApprovalError', 'recordMonthlyVersionChanges', 'currentMonthlyStamp',
  'requestMonthlyApproval', 'decideApproval', 'saveState',
  'renderMonthlyApprovalStatus', 'renderMonthlyVersions', 'renderApprovalBlock', 'escapeAttribute', 'buildExportName', 'saveNotesSection'];
function setup(){
  let count = 0, saves = 0;
  const fields = {
    '#approvalActorSelect': { value: 'boss' }, '#monthlyApprovalStatus': {},
    '#requestMonthlyBtn': {}, '#approvalBlock': {}
  };
  const c = vm.createContext({
    STATE: { monthlyApprovals: {}, versions: [], approvals: [], settings: { stationName: '관제실', notes: '비고', adminPin: 'NEVER_COPY' } },
    staff: [{ id: 'a', name: '직원', startDate: '2099-01-01' }], shift: '일',
    DEFAULT_STATION_NAME: '관제실', STORE_KEY: 'test', LOCAL_MODE: true, localSaveFailed: false,
    alerts: [], securityMessages: [], actor: { id: 'boss', name: '담당' },
    getCurrentMonthView: () => ({ year: 2099, monthIndex: 0 }),
    getToday: () => new Date('2099-01-01T00:00:00'),
    getActiveStaff: () => c.staff,
    isEmployeeActiveOnDate: (emp, date) => !emp.endDate || date.getDate() <= Number(emp.endDate.slice(-2)),
    getShiftForDate: () => c.shift,
    getApprovalLines: () => [{ title: '담당', name: '' }, { title: '팀장', name: '' }],
    uid: () => 'id' + ++count, $: sel => fields[sel],
    getApprovers: () => [c.actor], approverById: () => c.actor,
    requireAdmin: () => true,
    createApproval: value => {
      const approval = { ...value, id: 'request' + ++count, status: 'pending', approverIds: [c.actor.id] };
      c.STATE.approvals.push(approval); return approval;
    },
    localStorage: { setItem: () => saves++ }, showLocalStorageStatus(){},
    renderAll(){}, showToast(){}, notify(){}, addAuditLog(){},
    alert: message => c.alerts.push(message), prompt: () => '반려 사유',
    location: { reload(){} },
    securityMessage: message => c.securityMessages.push(message),
    flushPendingState: async () => {},
    askCredential: async () => ({ secret: '123456', reason: '반려 사유' }),
    // security.js decide()의 monthly 분기를 그대로 재현한다 — 실제 검증은 security.test.js가 담당.
    securityRequest: async (url, body) => {
      if (url !== '/api/approvals/decision') throw new Error('unexpected url: ' + url);
      const { id, approved, reason } = body;
      const approval = c.STATE.approvals.find(a => a.id === id);
      if (!approval || approval.status !== 'pending') throw new Error('이미 처리되었거나 없는 승인 요청입니다.');
      const at = new Date().toISOString();
      if (approval.type === 'monthly' && approved) {
        c.STATE.monthlyApprovals ||= {};
        if (approval.scheduleSnapshot) {
          c.STATE.versions ||= [];
          const number = Math.max(0, ...c.STATE.versions.filter(v => v.kind === 'monthly-approved' && v.monthKey === approval.refId).map(v => v.number)) + 1;
          const version = {
            id: 'ver' + ++count, kind: 'monthly-approved', monthKey: approval.refId, number,
            approvalId: approval.id, approverId: c.actor.id, approverName: c.actor.name, at,
            snapshot: JSON.parse(JSON.stringify(approval.scheduleSnapshot)) // 실제 서버는 HTTP body로 받으므로 항상 분리된 사본이다
          };
          c.STATE.versions.push(version);
          c.STATE.monthlyApprovals[approval.refId] = { versionId: version.id, number, approverId: c.actor.id, approverName: c.actor.name, at };
        } else {
          c.STATE.monthlyApprovals[approval.refId] = { approverId: c.actor.id, approverName: c.actor.name, at };
        }
      }
      Object.assign(approval, { status: approved ? 'approved' : 'rejected', decidedBy: c.actor.id, decidedAt: at, decisionReason: approved ? '' : (reason || '').trim() });
      return { ok: true };
    }
  });
  vm.runInContext(names.map(source).join('\n'), c);
  function request(){ c.requestMonthlyApproval(); return c.STATE.approvals.at(-1); }
  async function approve(){ const approval = request(); await c.decideApproval(approval.id, true); return approval; }
  return { c, fields, request, approve, saves: () => saves };
}

test('application script compiles and history panel stays out of PDF captures', () => {
  new vm.Script(script);
  assert.match(html, /id="monthlyVersionPanel" data-html2canvas-ignore="true"/);
});
test('approval request captures a detached display snapshot without credentials', () => {
  const f = setup(), approval = f.request();
  assert.equal(approval.scheduleSnapshot.employees[0].shifts.length, 31);
  assert.equal(approval.scheduleSnapshot.employees[0].shifts[0], '일');
  assert.ok(!JSON.stringify(approval.scheduleSnapshot).includes('NEVER_COPY'));
  f.c.shift = '휴가'; f.c.staff[0].name = '수정됨';
  assert.equal(approval.scheduleSnapshot.employees[0].name, '직원');
  assert.equal(approval.scheduleSnapshot.employees[0].shifts[0], '일');
});
test('approved version and stamp reference exactly the requested snapshot', async () => {
  const f = setup(), approval = await f.approve();
  const version = f.c.approvedMonthlyVersion('2099-01');
  assert.equal(approval.status, 'approved');
  assert.equal(version.number, 1);
  assert.equal(version.approvalId, approval.id);
  assert.equal(f.c.currentMonthlyStamp('2099-01').versionId, version.id);
  approval.scheduleSnapshot.notes = 'later mutation';
  assert.equal(version.snapshot.notes, '비고');
});
test('monthlyApprovalError blocks approval when the schedule changed since the request', () => {
  const f = setup(), approval = f.request();
  f.c.shift = '교육';
  assert.match(f.c.monthlyApprovalError(approval), /이후 근무표가 변경/);
});
test('a request whose schedule changed is rejected by decideApproval before contacting the server', async () => {
  const f = setup(), approval = f.request();
  f.c.shift = '교육';
  await f.c.decideApproval(approval.id, true);
  assert.equal(approval.status, 'pending');
  assert.equal(f.c.STATE.versions.length, 0);
  assert.equal(f.c.STATE.monthlyApprovals['2099-01'], undefined);
  assert.match(f.c.alerts[0], /이후 근무표가 변경/);
});
test('pending duplicate and unchanged reapproval requests are not created', async () => {
  const f = setup(); const approval = f.request(); f.request();
  assert.equal(f.c.STATE.approvals.length, 1);
  await f.c.decideApproval(approval.id, true); f.request();
  assert.equal(f.c.STATE.approvals.length, 1);
});
test('changes after approval invalidate live stamp and log once per changed save', async () => {
  const f = setup(); await f.approve();
  f.c.shift = '교육'; f.c.saveState(); f.c.saveState();
  assert.equal(f.c.currentMonthlyStamp('2099-01'), null);
  const changes = f.c.STATE.versions.filter(v => v.kind === 'monthly-change');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].changes.length, 31);
  assert.equal(f.c.approvedMonthlyVersion('2099-01').snapshot.employees[0].shifts[0], '일');
  f.c.renderMonthlyApprovalStatus(); f.c.renderApprovalBlock();
  assert.match(f.fields['#monthlyApprovalStatus'].textContent, /재확정 필요/);
  assert.equal(f.fields['#requestMonthlyBtn'].disabled, false);
  assert.match(f.fields['#approvalBlock'].innerHTML, /재확정 필요/);
});
test('restoring the original values preserves change history and restores matching status', async () => {
  const f = setup(); await f.approve();
  f.c.STATE.settings.notes = '변경'; f.c.saveState();
  f.c.STATE.settings.notes = '비고'; f.c.saveState();
  assert.equal(f.c.STATE.versions.filter(v => v.kind === 'monthly-change').length, 2);
  assert.ok(f.c.currentMonthlyStamp('2099-01'));
});
test('rejected reapproval keeps v1; approved reapproval creates v2 without overwriting v1', async () => {
  const f = setup(); await f.approve(); f.c.shift = '교육'; f.c.saveState();
  let approval = f.request(); await f.c.decideApproval(approval.id, false);
  assert.equal(f.c.approvedMonthlyVersion('2099-01').number, 1);
  approval = f.request(); await f.c.decideApproval(approval.id, true);
  const versions = f.c.STATE.versions.filter(v => v.kind === 'monthly-approved');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].snapshot.employees[0].shifts[0], '일');
  assert.equal(versions[1].snapshot.employees[0].shifts[0], '교육');
  assert.equal(f.c.currentMonthlyStamp('2099-01').number, 2);
});
test('legacy stamps and pending requests are not fabricated into historical snapshots', async () => {
  const f = setup();
  f.c.STATE.monthlyApprovals['2099-01'] = { approverName: '과거 담당', at: '2098-12-01' };
  f.c.saveState();
  assert.equal(f.c.STATE.versions.length, 0);
  assert.equal(f.c.currentMonthlyStamp('2099-01'), null);
  f.c.renderMonthlyApprovalStatus();
  assert.match(f.fields['#monthlyApprovalStatus'].textContent, /당시 확정본이 없습니다/);
  const old = { id: 'old', type: 'monthly', refId: '2099-01', status: 'pending', approverIds: ['boss'] };
  f.c.STATE.approvals.push(old);
  await f.c.decideApproval('old', true);
  assert.equal(old.status, 'pending');
  await f.c.decideApproval('old', false);
  assert.equal(f.c.STATE.monthlyApprovals['2099-01'].approverName, '과거 담당');
});
test('snapshot covers leap months, inactive days, employee additions/removals and metadata', () => {
  const f = setup();
  f.c.staff[0].endDate = '2104-02-15';
  const snapshot = f.c.monthlySnapshot('2104-02');
  assert.equal(snapshot.employees[0].shifts.length, 29);
  assert.equal(snapshot.employees[0].shifts[15], null);
  f.c.staff = [{ id: 'b', name: '새 직원' }];
  f.c.STATE.settings.notes = '변경';
  const diff = f.c.monthlySnapshotDiff(snapshot, f.c.monthlySnapshot('2104-02'));
  assert.ok(diff.some(v => v.label === '비고'));
  assert.equal(diff.filter(v => v.label.startsWith('직원 구성')).length, 2);
});
test('snapshot comparison remains valid after a JSON save and reload', async () => {
  const f = setup(); await f.approve(); f.c.saveState();
  f.c.STATE = JSON.parse(JSON.stringify(f.c.STATE));
  assert.ok(f.c.currentMonthlyStamp('2099-01'));
  f.c.saveState();
  assert.equal(f.c.STATE.versions.length, 1);
});
test('PDF filename reflects actual approval rather than the calendar deadline', async () => {
  const f = setup();
  assert.match(f.c.buildExportName('PDF'), /미확정/);
  await f.approve();
  assert.match(f.c.buildExportName('PDF'), /확정v1/);
  f.c.shift = '교육';
  assert.match(f.c.buildExportName('PDF'), /재확정필요/);
});
test('saving notes refreshes status and removes the current-table approval stamp immediately', async () => {
  const f = setup(); await f.approve();
  f.fields['#scheduleNotesInput'] = { value: '변경된 비고' };
  f.c.saveNotesSection();
  assert.match(f.fields['#monthlyApprovalStatus'].textContent, /재확정 필요/);
  assert.match(f.fields['#approvalBlock'].innerHTML, /재확정 필요/);
});
test('stored snapshot text is escaped in the history viewer', async () => {
  const f = setup(); f.c.staff[0].name = '<img src=x onerror=alert(1)>';
  await f.approve();
  const select = { value: '', addEventListener() {} };
  f.fields['#monthlyVersionContent'] = { querySelector: () => select };
  f.c.renderMonthlyVersions('2099-01');
  assert.ok(!f.fields['#monthlyVersionContent'].innerHTML.includes('<img'));
  assert.match(f.fields['#monthlyVersionContent'].innerHTML, /&lt;img/);
});
