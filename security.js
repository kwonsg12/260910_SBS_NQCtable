const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');
const activityLog = require('./activityLog');
const { employeeName } = require('./employeeNames');

// 근무표 날짜는 한국 시간 기준이다(서버 PC 시간대와 무관하게).
function kstToday() { return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10); }
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const secretKeys = new Set(['pin', 'adminPin', 'smtpPass', 'kakaoKey', 'pinHash', '__proto__', 'constructor', 'prototype']);
function publicState(value) {
  if (Array.isArray(value)) return value.map(publicState);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key)).map(([key, item]) => [key, publicState(item)]));
}
function validateTree(value, depth = 0) {
  if (depth > 24) fail(400, '입력 구조가 너무 깊습니다.');
  if (typeof value === 'string' && value.length > 20000) fail(400, '입력 내용이 너무 깁니다.');
  if (value && typeof value === 'object') {
    if (Object.keys(value).length > 20000) fail(400, '입력 항목이 너무 많습니다.');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail(400, '허용하지 않는 입력 키입니다.');
      validateTree(item, depth + 1);
    }
  }
}
function list(state, key) {
  const items = state[key] ?? [];
  if (!Array.isArray(items)) fail(400, key + ': 목록이 필요합니다.');
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) fail(400, key + ': ID가 잘못되었거나 중복됩니다.');
    ids.add(item.id);
  }
  return items;
}
// 등록된 담당자 전원이 모든 승인을 담당한다(담당 범위 구분 없음).
function targets(state) {
  return list(state, 'approvers').map(a => a.id);
}
// 근무표 수동 편집으로 바뀌는 값(달별 비고 포함). 시스템 관리자와 승인 담당자(scheduleEditor)가 바꿀 수 있다.
const SCHEDULE_KEYS = ['scheduleOverrides', 'scheduleSnapshots', 'scheduleRanges', 'rotationAnchors', 'monthNotes'];
// 시스템 설정(직원 구성·담당자·설정). 시스템 관리자와 승인 담당자(로그인)만 바꿀 수 있다.
// 2026-11-27 사용자: 승인 담당자와 관리자의 권한은 기본적으로 같게 — 화면에서 무엇을 보여 주느냐만 다르다.
const SYSTEM_KEYS = ['settings', 'employees', 'approvers', 'deletedEmployeesTrash', 'formerEmployees'];
// 신규 날짜별 순서·인계 기록도 직원 구성과 같은 권한이다. 이전 저장소에는 키가 없을 수 있다.
const STAFF_HISTORY_KEYS = ['employeeOrderHistory', 'staffHandoverEvents'];
function validStaffDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date))
    && new Date(date).toISOString().slice(0, 10) === date;
}
function validateStaffHistory(old, next) {
  const before = list(old, 'staffHandoverEvents'), events = list(next, 'staffHandoverEvents');
  const today = kstToday();
  const orderHistory = next.employeeOrderHistory || [];
  if (!Array.isArray(orderHistory)) fail(400, '직원 순서 이력 형식이 잘못되었습니다.');
  for (const entry of orderHistory) {
    if (entry?.from && (!validStaffDate(entry.from) || (entry.eventId ? !entry.move?.incoming : !Array.isArray(entry.order) || new Set(entry.order).size !== entry.order.length))) {
      fail(400, '날짜별 직원 순서 이력이 잘못되었습니다.');
    }
  }
  // 확정/과거 근무의 출처인 이미 시작된 인계 자체는 덮어쓰거나 제거하지 않는다.
  for (const event of before) {
    if (event.from <= today && !equal(event, events.find(e => e.id === event.id))) fail(409, '이미 시작된 직원 인계는 변경할 수 없습니다.');
  }
  const ids = new Set(), employees = list(next, 'employees'), anchors = next.rotationAnchors || [];
  for (const event of events) {
    const prior = before.find(e => e.id === event.id);
    if (!validStaffDate(event.from) || (!prior && event.from < today) || !['NC', 'TC', 'transfer'].includes(event.target)
      || !['TC', 'transfer'].includes(event.outgoingAction)) fail(400, '직원 인계 날짜·형태를 확인해주세요.');
    // 이전에 완료된 직원의 완전 삭제 등 기존 관리 기능은 계속 허용한다.
    if (event.from < today) continue;
    const outgoing = employees.find(e => e.id === event.outgoingId), incoming = employees.find(e => e.id === event.incomingId);
    if ((!outgoing && event.outgoingId) || (!incoming && event.incomingId) || (!outgoing && !incoming) || (outgoing && outgoing.id === incoming?.id)
      || (event.primaryId !== outgoing?.id && event.primaryId !== incoming?.id)) fail(400, '인계 직원 정보가 일치하지 않습니다.');
    if (event.placement != null && (!incoming || !['extra', 'routine'].includes(event.placement)
      || (event.placement === 'extra' ? !!outgoing || event.target !== 'NC' : !outgoing))) fail(409, '추가 교대 자리와 기존 교대 자리 인계를 확인해주세요.');
    for (const emp of [outgoing, incoming].filter(Boolean)) {
      if (ids.has(emp.id)) fail(409, '한 직원에게 예정된 인계가 중복됩니다.');
      ids.add(emp.id);
      if ((emp.startDate || '2026-01-01') > event.from || (emp.adaptationPeriods || []).some(p => p.endDate >= event.from)) fail(409, '적응기간 또는 재직 기간과 인계가 겹칩니다.');
    }
    if (outgoing && event.outgoingAction === 'transfer') {
      const previousDay = new Date(Date.parse(event.from) - 86400000).toISOString().slice(0, 10);
      if (outgoing.endDate !== previousDay) fail(409, '전출일과 인계일이 일치하지 않습니다.');
    } else if (outgoing && (!(outgoing.workTypeChanges || []).some(c => c.eventId === event.id && c.from === event.from && c.workType === 'TC')
      || (outgoing.endDate && outgoing.endDate < event.from))) fail(409, '기존 직원의 근무 형태 변경이 인계와 연결되어야 합니다.');
    if (incoming) {
      const type = [...(incoming.workTypeChanges || [])].filter(c => c.from <= event.from)
        .sort((a, b) => a.from.localeCompare(b.from) || String(a.at).localeCompare(String(b.at))).at(-1)?.workType || incoming.workType;
      const matchingAnchors = anchors.filter(a => a.eventId === event.id);
      const matchingOrders = orderHistory.filter(e => e.eventId === event.id);
      if (type !== 'NC' || (incoming.endDate && incoming.endDate < event.from)
        || (incoming.onboarding && (!incoming.soloDeployment?.from || incoming.soloDeployment.from > event.from))
        || matchingAnchors.length !== 1 || matchingAnchors[0].empId !== incoming.id || matchingAnchors[0].startDate !== event.from
        || matchingAnchors[0].startShift !== event.startShift || !['일', '야', '조', 'O'].includes(event.startShift)
        || matchingOrders.length !== 1 || matchingOrders[0].from !== event.from || matchingOrders[0].move?.incoming !== incoming.id
        || (matchingOrders[0].move?.outgoing || null) !== (outgoing?.id || null)) fail(409, '교대 자리·단독 투입·로테이션이 같은 인계로 연결되어야 합니다.');
    }
  }
  const eventIds = new Set(events.map(e => e.id));
  const linked = [...anchors, ...orderHistory, ...employees.flatMap(e => e.workTypeChanges || [])];
  if (linked.some(e => e.eventId && !eventIds.has(e.eventId))) fail(409, '직원 인계와 연결된 이력이 남아 있습니다.');
  for (const emp of employees) {
    const roles = emp.rotationRoleChanges || [];
    if (!Array.isArray(roles) || new Set(roles.map(r => r?.eventId)).size !== roles.length || roles.some(r => {
      if (!r) return true;
      const event = events.find(e => e.id === r.eventId);
      return !validStaffDate(r.from) || !['extra', 'routine'].includes(r.role) || !event
        || event.incomingId !== emp.id || event.from !== r.from || event.placement !== r.role;
    }) || events.some(event => event.incomingId === emp.id && event.placement && !roles.some(r => r.eventId === event.id))) {
      fail(409, '추가 교대·자동대근 역할은 연결된 인계 기록과 함께 저장해야 합니다.');
    }
    const periods = emp.adaptationPeriods || [];
    if (!Array.isArray(periods)) fail(400, '적응기간 형식이 잘못되었습니다.');
    if (periods.some((p, i) => !validStaffDate(p.startDate) || !validStaffDate(p.endDate) || p.startDate > p.endDate || p.empId !== emp.id
      || p.startDate < (emp.startDate || '2026-01-01') || (emp.endDate && p.endDate > emp.endDate)
      || !Array.isArray(p.pattern) || !p.pattern.length || p.pattern.some(s => typeof s !== 'string' || !s.length || s.length > 4)
      || periods.slice(i + 1).some(q => p.startDate <= q.endDate && q.startDate <= p.endDate)
      || (emp.soloDeployment && p.endDate >= emp.soloDeployment.from))) fail(409, '적응기간이 중복되거나 단독 투입일과 겹칩니다.');
    if (emp.soloDeployment?.eventId && !eventIds.has(emp.soloDeployment.eventId)) fail(409, '단독 투입의 인계 정보가 없습니다.');
    const previousPeriods = list(old, 'employees').find(e => e.id === emp.id)?.adaptationPeriods || [];
    if (previousPeriods.some(p => p.startDate <= today && !periods.some(q => equal(p, q)))) fail(409, '이미 시작된 적응기간은 변경할 수 없습니다.');
  }
}
function validateSave(previous, incoming, admin, employeeId = null, scheduleEditor = false) {
  validateTree(incoming);
  const next = publicState(incoming), old = publicState(previous || {});
  for (const key of ['employees', 'approvers', 'requests', 'protects', 'approvals', 'excuses']) list(next, key);
  if (!next.settings || typeof next.settings !== 'object' || Array.isArray(next.settings)) fail(400, '설정 형식이 잘못되었습니다.');
  if (!Number.isInteger(next.settings.quotaMax) || next.settings.quotaMax < 1 || next.settings.quotaMax > 31) fail(400, '보장 횟수는 1~31 정수여야 합니다.');
  if (!previous && !admin) fail(403, '최초 공유 저장소 설정은 시스템 관리자 인증이 필요합니다.');
  const canEditSchedule = admin || scheduleEditor;
  if (!admin) {
    for (const key of SYSTEM_KEYS) {
      if (!equal(old[key], next[key])) fail(403, '직원 구성·담당자·시스템 설정 변경은 시스템 관리자 인증이 필요합니다.');
    }
    for (const key of STAFF_HISTORY_KEYS) {
      if (!equal(old[key] || [], next[key] || [])) fail(403, '직원 구성 변경은 관리자 또는 승인 담당자 인증이 필요합니다.');
    }
  }
  if (!canEditSchedule) {
    for (const key of SCHEDULE_KEYS) {
      if (!equal(old[key], next[key])) fail(403, '근무표 수동 편집은 시스템 관리자 또는 승인 담당자 로그인이 필요합니다.');
    }
  }
  if (admin && ['employees', 'rotationAnchors', ...STAFF_HISTORY_KEYS].some(key => !equal(old[key] || [], next[key] || []))) validateStaffHistory(old, next);
  // Even administrators must use the decision endpoint. Old approvals cannot be removed/replaced.
  if (!equal(old.monthlyApprovals || {}, next.monthlyApprovals || {})) fail(409, '월 확정은 승인함에서 처리해주세요.');
  // versions(월 확정본·변경 이력 등 과거 스냅샷)는 항목 형태가 제각각이라 id 스키마를 강제하지
  // 않는다. 대신 append-only만 강제한다 — 기존 항목은 (관리자 포함) 순서 포함 그대로 남아야
  // 하고 뒤에 새 항목만 추가할 수 있다. 실제 월 확정 기록은 decide()가 별도로 관리한다.
  const oldVersions = Array.isArray(old.versions) ? old.versions : [];
  const nextVersions = Array.isArray(next.versions) ? next.versions : [];
  if (nextVersions.length < oldVersions.length || oldVersions.some((v, i) => !equal(v, nextVersions[i]))) {
    fail(409, '기존 변경 이력은 수정할 수 없습니다. 새로고침 후 다시 시도하세요.');
  }
  for (const key of ['requests', 'protects', 'approvals', 'excuses']) {
    for (const before of list(old, key)) {
      if (!equal(before, list(next, key).find(item => item.id === before.id))) fail(409, '기존 신청/승인이 변경되었습니다. 새로고침 후 다시 시도하세요.');
    }
  }
  const added = key => list(next, key).filter(item => !list(old, key).some(before => before.id === item.id));
  if (!equal(old.approvers, next.approvers)) {
    for (const approval of list(old, 'approvals').filter(a => a.status === 'pending')) {
      if (!targets(next).some(id => approval.approverIds?.includes(id))) {
        fail(409, '대기 중인 신청을 처리할 담당자가 없어집니다. 먼저 승인을 처리해주세요.');
      }
    }
  }
  for (const req of added('requests')) {
    if (!list(next, 'employees').some(e => e.id === req.empId)) fail(400, '신청 직원이 없습니다.');
    // 관리자가 근무표에 직접 넣은 휴가(enteredBy: 'admin')는 직원에게 듣고 넣은 것이라 이미 확정된 신청으로 저장한다.
    // 근무표를 편집할 수 있는 사람(시스템 관리자·승인 담당자)만 넣을 수 있다.
    if (req.enteredBy !== undefined && (req.enteredBy !== 'admin' || !canEditSchedule)) fail(403, '관리자 입력 휴가는 근무표 편집 권한이 있어야 등록할 수 있습니다.');
    if (!admin && req.enteredBy !== 'admin') {
      if (!employeeId) fail(401, '로그인 후 신청할 수 있습니다.');
      if (req.empId !== employeeId) fail(403, '본인 명의로만 신청할 수 있습니다.');
    }
    const expected = req.enteredBy === 'admin' ? 'confirmed' : (list(next, 'approvers').length ? 'pending' : 'confirmed');
    if (req.status !== expected) fail(403, '휴가 승인 결과를 직접 지정할 수 없습니다.');
    if (!Array.isArray(req.chain) || !/^\d{4}-\d{2}-\d{2}$/.test(req.startDate)) fail(400, '휴가 신청 형식을 확인해주세요.');
  }
  const counted = [...list(old, 'protects')];
  for (const req of added('protects')) {
    if (!list(next, 'employees').some(e => e.id === req.empId) || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) fail(400, '보장 신청 직원/날짜를 확인해주세요.');
    if (!admin) {
      if (!employeeId) fail(401, '로그인 후 신청할 수 있습니다.');
      if (req.empId !== employeeId) fail(403, '본인 명의로만 신청할 수 있습니다.');
    }
    const used = counted.filter(p => p.empId === req.empId && p.date.slice(0, 7) === req.date.slice(0, 7) && p.status !== 'cancelled').length;
    const needsApproval = used >= next.settings.quotaMax;
    if (req.status !== (needsApproval ? 'pending' : 'approved') || req.needsApproval !== needsApproval) fail(403, '비번 보장 승인 결과를 직접 지정할 수 없습니다.');
    counted.push(req);
  }
  for (const excuse of added('excuses')) {
    if (!list(next, 'employees').some(e => e.id === excuse.empId)) fail(400, '사유 제출 대상 직원이 없습니다.');
    if (typeof excuse.reason !== 'string' || !excuse.reason.trim() || excuse.reason.length > 2000) fail(400, '대근 불가 사유를 확인해주세요.');
    if (!admin) {
      if (!employeeId) fail(401, '로그인 후 사유를 제출할 수 있습니다.');
      if (excuse.empId !== employeeId) fail(403, '본인 명의로만 사유를 제출할 수 있습니다.');
    }
  }
  const approvals = added('approvals');
  // 대기 중인 중복 요청만 막는다 — monthly는 재확정을 위해 같은 월(refId)로 반복 요청되므로,
  // 이미 승인/반려되어 처리가 끝난 건까지 막으면 재확정 요청 자체가 불가능해진다.
  const seen = new Set(list(old, 'approvals').filter(a => a.status === 'pending').map(a => a.type + ':' + a.refId));
  for (const approval of approvals) {
    const key = approval.type + ':' + approval.refId;
    if (seen.has(key)) fail(400, '같은 신청의 승인 요청이 이미 있습니다.');
    seen.add(key);
    if (approval.status !== 'pending' || approval.decidedBy || approval.decidedAt || approval.decisionReason) fail(403, '승인 결과는 서버에서만 기록합니다.');
    if (!['leave', 'protect', 'monthly'].includes(approval.type)) fail(400, '지원하지 않는 승인 종류입니다.');
    if (approval.type === 'monthly') {
      if (!/^\d{4}-\d{2}$/.test(approval.refId) || approval.requestedBy !== null) fail(400, '월 확정 요청 형식을 확인해주세요.');
    } else {
      const request = added(approval.type === 'leave' ? 'requests' : 'protects').find(r => r.id === approval.refId);
      if (!request || request.status !== 'pending' || request.empId !== approval.requestedBy) fail(400, '승인 요청과 신규 신청이 일치하지 않습니다.');
    }
    const assigned = targets(next);
    if (!assigned.length || !equal(approval.approverIds, assigned)) fail(400, '승인 담당자를 등록해주세요.');
  }
  for (const key of ['requests', 'protects']) for (const req of added(key)) {
    const type = key === 'requests' ? 'leave' : 'protect';
    if (req.status === 'pending' && !approvals.some(a => a.type === type && a.refId === req.id)) fail(400, '승인 대기 신청에는 승인 요청이 필요합니다.');
  }
  return next;
}

// onMonthlyApproved(version): 월 근무표 확정이 승인되어 DB 에 저장된 뒤 호출된다(서버 PC 엑셀 백업용).
// 실패해도 승인은 이미 끝난 것이므로 결과에 영향을 주지 않는다.
function createSecurity({ db, getState, setState, adminPassword = process.env.ADMIN_PASSWORD || '', onMonthlyApproved = null }) {
  db.exec('CREATE TABLE IF NOT EXISTS approval_credentials (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS employee_credentials (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)');
  // 기본 PIN(0000) 상태인 직원. 이 목록에 있으면 첫 로그인 때 PIN을 바꾸기 전에는 다른 일을 할 수 없다.
  db.exec('CREATE TABLE IF NOT EXISTS employee_default_pins (id TEXT PRIMARY KEY)');
  const DEFAULT_EMPLOYEE_PIN = '0000';
  const sessions = new Map(), employeeSessions = new Map(), approverSessions = new Map(), attempts = new Map();
  const adminSalt = randomBytes(16).toString('hex');
  const adminHash = scryptSync(adminPassword, adminSalt, 32).toString('hex');
  function writePin(table, id, pin) {
    const salt = randomBytes(16).toString('hex');
    db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash`).run(id, salt, scryptSync(pin, salt, 32).toString('hex'));
  }
  // PIN이 없는 직원에게 기본 PIN을 넣는다. 처음 등록할 때와, 서버가 뜰 때 PIN 없는 기존 직원에게 쓴다.
  function ensureDefaultEmployeePin(id) {
    if (db.prepare('SELECT id FROM employee_credentials WHERE id=?').get(id)) return;
    writePin('employee_credentials', id, DEFAULT_EMPLOYEE_PIN);
    db.prepare('INSERT OR IGNORE INTO employee_default_pins VALUES (?)').run(id);
  }
  function setEmployeePin(id, pin) {
    writePin('employee_credentials', id, pin);
    db.prepare('DELETE FROM employee_default_pins WHERE id=?').run(id);
  }
  function hasDefaultPin(id) {
    return !!db.prepare('SELECT id FROM employee_default_pins WHERE id=?').get(id);
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = work(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  function persist(state, row) {
    if (setState(state, row?.revision ?? 0) === null) fail(409, '다른 PC에서 저장했습니다. 새로고침해주세요.');
  }
  // Migrate legacy plaintext PINs once and remove secrets from nested versions too.
  // pinConfigured도 여기서 한 번에 반영해둬야, 최초 save() 호출 시점에 employees/approvers
  // 배열 모양이 처음으로 바뀌면서 이미 상태를 받아간 클라이언트의 저장이 엉뚱하게 거부되지 않는다.
  transaction(() => {
    const row = getState();
    if (!row) return;
    const state = publicState(row.state);
    state.approvers = (row.state.approvers || []).map(a => {
      if (typeof a.pin === 'string' && a.pin && !db.prepare('SELECT id FROM approval_credentials WHERE id=?').get(a.id)) writePin('approval_credentials', a.id, a.pin);
      return { ...publicState(a), pinConfigured: !!db.prepare('SELECT id FROM approval_credentials WHERE id=?').get(a.id) };
    });
    state.employees = (row.state.employees || []).map(e => {
      ensureDefaultEmployeePin(e.id);
      return { ...publicState(e), pinConfigured: true };
    });
    // .env에 기본 담당자(DEFAULT_APPROVER_*)를 설정해두면, 담당자가 0명이 되지 않도록 서버가
    // 뜰 때마다 그 담당자를 등록/동기화한다. PIN은 화면에서 직접 정하지 않는 한 자동 생성되며,
    // 실사용은 관리자 로그인으로 처리(PIN 불필요)하는 걸 전제로 한다.
    if (process.env.DEFAULT_APPROVER_NAME && process.env.DEFAULT_APPROVER_EMAIL) {
      const id = 'default_approver';
      const existing = state.approvers.find(a => a.id === id);
      if (process.env.DEFAULT_APPROVER_PIN) writePin('approval_credentials', id, process.env.DEFAULT_APPROVER_PIN);
      else if (!existing) writePin('approval_credentials', id, randomBytes(4).toString('hex'));
      if (existing) { existing.name = process.env.DEFAULT_APPROVER_NAME; existing.email = process.env.DEFAULT_APPROVER_EMAIL; existing.pinConfigured = true; }
      else state.approvers.push({ id, name: process.env.DEFAULT_APPROVER_NAME, email: process.env.DEFAULT_APPROVER_EMAIL, pinConfigured: true });
    }
    if (!equal(row.state, state)) persist(state, row);
  });
  // 로그인은 마지막 동작 후 SESSION_IDLE_MS 동안 유지된다. 화면이 사용자 동작(클릭·키보드 등)을 감지하면
  // /api/auth/touch 로 알려 오고, 저장·승인·취소 같은 요청도 동작으로 본다. 편집 잠금 하트비트는
  // 동작이 아니므로 연장하지 않는다(창만 열어 두면 15분 뒤 로그아웃).
  const SESSION_IDLE_MS = Number(process.env.SESSION_IDLE_MS) || 15 * 60 * 1000;
  function touch(req) {
    const now = Date.now(), until = now + SESSION_IDLE_MS;
    const adminToken = req.get('X-Admin-Token');
    const admin = (sessions.get(adminToken) || 0) > now;
    if (admin) sessions.set(adminToken, until);
    const employee = employeeSessions.get(req.get('X-Employee-Token'));
    const employeeOk = !!employee && employee.expires > now;
    if (employeeOk) employee.expires = until;
    const approver = approverSessions.get(req.get('X-Approver-Token'));
    const approverOk = !!approver && approver.expires > now;
    if (approverOk) approver.expires = until;
    return { ok: true, admin, employee: employeeOk, approver: approverOk };
  }
  function isAdmin(req) {
    const token = req.get('X-Admin-Token');
    if ((sessions.get(token) || 0) > Date.now()) return true;
    sessions.delete(token);
    return false;
  }
  // 권한 판단용: 시스템 관리자 또는 승인 담당자 로그인. 둘의 서버 권한은 같다(2026-11-27).
  // 누가 했는지(잠금 이름·기록)는 여전히 각자의 이름으로 남는다(callerKey, decide 의 actor).
  function isManager(req) {
    return isAdmin(req) || !!approverSession(req);
  }
  // 기본 PIN으로 로그인한 세션(mustChange)은 PIN을 바꾸기 전까지 직원 권한으로 인정하지 않는다.
  function employeeSession(req) {
    const token = req.get('X-Employee-Token');
    const session = employeeSessions.get(token);
    if (session && session.expires > Date.now()) return session;
    employeeSessions.delete(token);
    return null;
  }
  function isEmployee(req) {
    const session = employeeSession(req);
    return session && !session.mustChange ? session.empId : null;
  }
  function approverSession(req) {
    const token = req.get('X-Approver-Token');
    const session = approverSessions.get(token);
    if (session && session.expires > Date.now()) return session.approverId;
    approverSessions.delete(token);
    return null;
  }
  function verify(key, value, salt, hash) {
    const now = Date.now();
    for (const [id, attempt] of attempts) if (attempt.until <= now) attempts.delete(id);
    const entry = attempts.get(key) || { count: 0, until: now + 15 * 60 * 1000 };
    if (entry.count >= 5) fail(429, '인증 시도가 많습니다. 15분 후 다시 시도해주세요.');
    if (typeof value !== 'string' || value.length > 256) fail(400, '인증값 형식을 확인해주세요.');
    if (!timingSafeEqual(scryptSync(value, salt, 32), Buffer.from(hash, 'hex'))) {
      entry.count++; attempts.set(key, entry); fail(401, '인증 정보가 일치하지 않습니다.');
    }
    attempts.delete(key);
  }
  function login(req) {
    if (adminPassword.length < 12) fail(503, '서버 .env에 ADMIN_PASSWORD를 12자 이상으로 설정해주세요.');
    verify('admin', req.body?.password, adminSalt, adminHash);
    for (const [token, expires] of sessions) if (expires <= Date.now()) sessions.delete(token);
    if (sessions.size >= 100) sessions.delete(sessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_IDLE_MS);
    return { token };
  }
  function employeeLogin(req) {
    const { empId, pin } = req.body || {};
    if (typeof empId !== 'string' || !empId) fail(400, '직원을 선택해주세요.');
    const row = getState();
    const employee = row?.state?.employees?.find(e => e.id === empId);
    if (!employee) fail(400, '등록된 직원이 아닙니다.');
    ensureDefaultEmployeePin(empId);
    const credentials = db.prepare('SELECT salt, hash FROM employee_credentials WHERE id=?').get(empId);
    verify('employee:' + empId, pin, credentials.salt, credentials.hash);
    for (const [token, session] of employeeSessions) if (session.expires <= Date.now()) employeeSessions.delete(token);
    if (employeeSessions.size >= 100) employeeSessions.delete(employeeSessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    const mustChange = hasDefaultPin(empId);
    employeeSessions.set(token, { empId, mustChange, expires: Date.now() + SESSION_IDLE_MS });
    return { token, empId, name: employee.name, mustChangePin: mustChange };
  }
  // 직원 본인 PIN 변경. 로그인 토큰과 현재 PIN을 함께 확인한다. 기본 PIN 상태도 여기서 풀린다.
  function changeEmployeePin(req) {
    const session = employeeSession(req);
    if (!session) fail(401, '로그인이 필요합니다.');
    const { currentPin, newPin } = req.body || {};
    const credentials = db.prepare('SELECT salt, hash FROM employee_credentials WHERE id=?').get(session.empId);
    if (!credentials) fail(403, 'PIN이 설정되지 않았습니다. 관리자에게 설정을 요청해주세요.');
    verify('employee:' + session.empId, currentPin, credentials.salt, credentials.hash);
    if (typeof newPin !== 'string' || newPin.length < 6 || newPin.length > 128) fail(400, '새 PIN은 6~128자로 입력해주세요.');
    if (newPin === currentPin) fail(400, '지금 PIN과 다른 PIN을 입력해주세요.');
    setEmployeePin(session.empId, newPin);
    session.mustChange = false;
    return { ok: true };
  }
  // 승인 담당자 로그인: 담당자 PIN을 한 번 확인하고 15분 동안 승인·반려에 PIN을 다시 묻지 않는다.
  function approverLogin(req) {
    const { approverId, pin } = req.body || {};
    if (typeof approverId !== 'string' || !approverId) fail(400, '담당자를 선택해주세요.');
    const approver = getState()?.state?.approvers?.find(a => a.id === approverId);
    if (!approver) fail(400, '등록된 담당자가 아닙니다.');
    const credentials = db.prepare('SELECT salt, hash FROM approval_credentials WHERE id=?').get(approverId);
    if (!credentials) fail(403, '담당자 PIN이 없습니다. 관리자에게 PIN 설정을 요청해주세요.');
    verify('approver:' + approverId, pin, credentials.salt, credentials.hash);
    for (const [token, session] of approverSessions) if (session.expires <= Date.now()) approverSessions.delete(token);
    if (approverSessions.size >= 100) approverSessions.delete(approverSessions.keys().next().value);
    const token = randomBytes(32).toString('hex');
    approverSessions.set(token, { approverId, expires: Date.now() + SESSION_IDLE_MS });
    return { token, approverId, name: approver.name };
  }
  function save(req) {
    return transaction(() => {
      const row = getState();
      if (row?.revision !== undefined && req.body?.baseRevision !== row.revision) fail(409, '다른 PC에서 저장했습니다. 새로고침해주세요.');
      const incoming = req.body?.state;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) fail(400, 'invalid state payload');
      touch(req);
      const admin = isManager(req), employeeId = admin ? null : isEmployee(req);
      const next = validateSave(row?.state, incoming, admin, employeeId, admin);
      const pins = req.body.approverPins || {};
      if (typeof pins !== 'object' || Array.isArray(pins)) fail(400, 'PIN 형식을 확인해주세요.');
      if (Object.keys(pins).length && !admin) fail(403, '담당자 PIN 변경은 관리자 인증이 필요합니다.');
      next.approvers = list(next, 'approvers').map(a => {
        const existing = db.prepare('SELECT id FROM approval_credentials WHERE id=?').get(a.id);
        const pin = pins[a.id];
        if (pin !== undefined) {
          if (typeof pin !== 'string' || pin.length < 6 || pin.length > 128) fail(400, '담당자 PIN은 6~128자로 입력해주세요.');
          writePin('approval_credentials', a.id, pin);
        } else if (!existing && !list(row?.state || {}, 'approvers').some(old => old.id === a.id)) fail(400, '신규 담당자의 PIN을 설정해주세요.');
        return { ...a, pinConfigured: !!(pin || existing) };
      });
      for (const a of list(row?.state || {}, 'approvers')) if (!next.approvers.some(n => n.id === a.id)) db.prepare('DELETE FROM approval_credentials WHERE id=?').run(a.id);

      const employeePins = req.body.employeePins || {};
      if (typeof employeePins !== 'object' || Array.isArray(employeePins)) fail(400, '직원 PIN 형식을 확인해주세요.');
      if (Object.keys(employeePins).length && !admin) fail(403, '직원 PIN 변경은 관리자 인증이 필요합니다.');
      next.employees = list(next, 'employees').map(e => {
        const existing = db.prepare('SELECT id FROM employee_credentials WHERE id=?').get(e.id);
        const pin = employeePins[e.id];
        if (pin !== undefined) {
          if (typeof pin !== 'string' || pin.length < 6 || pin.length > 128) fail(400, '직원 PIN은 6~128자로 입력해주세요.');
          setEmployeePin(e.id, pin);
        } else if (!existing) ensureDefaultEmployeePin(e.id); // 새로 등록한 직원은 기본 PIN(0000)으로 시작
        return { ...e, pinConfigured: true };
      });
      for (const e of list(row?.state || {}, 'employees')) if (!next.employees.some(n => n.id === e.id)) {
        db.prepare('DELETE FROM employee_credentials WHERE id=?').run(e.id);
        db.prepare('DELETE FROM employee_default_pins WHERE id=?').run(e.id);
      }

      persist(next, row);
      activityLog.logNewSubmissions(row?.state, next);
      const saved = getState();
      return { ok: true, updatedAt: saved.updatedAt, ...(saved.revision !== undefined ? { revision: saved.revision } : {}) };
    });
  }
  function decide(req) {
    const { id, approverId, pin, approved, reason = '' } = req.body || {};
    if (typeof approved !== 'boolean' || typeof reason !== 'string' || reason.length > 2000 || (!approved && !reason.trim())) fail(400, '승인 여부와 반려 사유를 확인해주세요.');
    touch(req);
    const admin = isManager(req);
    let approvedVersion = null;
    const result = transaction(() => {
      const row = getState(), state = row?.state;
      const actor = state?.approvers?.find(a => a.id === approverId);
      if (admin) {
        // 관리자·승인 담당자 로그인은 PIN 없이도 처리할 수 있다 — 다만 기록(decidedBy)에 남길 담당자는 골라야 한다.
        if (!actor) fail(400, '기록에 남길 담당자를 선택해주세요.');
      } else if (!actor || approverSession(req) !== actor.id) {
        // 담당자로 로그인한 세션이면 그 담당자 이름의 처리는 PIN을 다시 묻지 않는다.
        const credentials = actor && db.prepare('SELECT salt, hash FROM approval_credentials WHERE id=?').get(actor.id);
        if (!credentials) fail(403, '담당자 PIN이 없습니다. 관리자에게 PIN 설정을 요청해주세요.');
        verify('approver:' + actor.id, pin, credentials.salt, credentials.hash);
      }
      const approval = state.approvals.find(a => a.id === id);
      if (!approval || approval.status !== 'pending') fail(409, '이미 처리되었거나 없는 승인 요청입니다.');
      // 관리자는 이 건에 지정된 담당 범위가 아니어도 대신 처리할 수 있다.
      if (!admin && (!approval.approverIds?.includes(actor.id) || !targets(state).includes(actor.id))) fail(403, '이 신청을 담당하는 승인권자가 아닙니다.');
      const at = new Date().toISOString();
      if (approval.type === 'monthly') {
        // 재확정 요청을 반려해도 이전 확정본과 승인 도장은 그대로 둔다.
        if (approved) {
          state.monthlyApprovals ||= {};
          if (approval.scheduleSnapshot) {
            // 신청 시 첨부된 스냅샷을 그대로 확정본으로 보관한다 — 서버는 근무표를 다시 계산하지 않는다.
            state.versions ||= [];
            const number = Math.max(0, ...state.versions.filter(v => v.kind === 'monthly-approved' && v.monthKey === approval.refId).map(v => v.number)) + 1;
            const version = {
              id: 'ver_' + randomBytes(12).toString('hex'), kind: 'monthly-approved', monthKey: approval.refId, number,
              approvalId: approval.id, approverId: actor.id, approverName: actor.name, at, snapshot: approval.scheduleSnapshot
            };
            state.versions.push(version);
            approvedVersion = version;
            state.monthlyApprovals[approval.refId] = { versionId: version.id, number, approverId: actor.id, approverName: actor.name, at };
          } else {
            state.monthlyApprovals[approval.refId] = { approverId: actor.id, approverName: actor.name, at };
          }
        }
      } else if (approval.type === 'leave-cancel') {
        // 확정 휴가의 취소 신청: 승인되면 휴가와 대근 배정이 함께 풀린다. 반려되면 휴가는 그대로 확정이다.
        const request = state.requests?.find(r => r.id === approval.refId);
        if (!request || request.status !== 'confirmed') fail(409, '신청 상태가 변경되었습니다.');
        if (approved) Object.assign(request, { status: 'cancelled', cancelledAt: at });
      } else if (['leave', 'protect'].includes(approval.type)) {
        const request = state[approval.type === 'leave' ? 'requests' : 'protects']?.find(r => r.id === approval.refId);
        if (!request || request.status !== 'pending') fail(409, '신청 상태가 변경되었습니다.');
        request.status = approval.type === 'leave' ? (approved ? 'confirmed' : 'cancelled') : (approved ? 'approved' : 'rejected');
      } else fail(400, '지원하지 않는 승인 종류입니다.');
      Object.assign(approval, { status: approved ? 'approved' : 'rejected', decidedBy: actor.id, decidedAt: at, decisionReason: approved ? '' : reason.trim() });
      state.auditLogs ||= [];
      state.auditLogs.unshift({ id: 'decision_' + randomBytes(12).toString('hex'), action: approved ? '승인' : '반려', details: { approvalId: id, approverId: actor.id }, at });
      persist(state, row);
      activityLog.logDecision(state, approval, approved, actor.name, approval.decisionReason);
      return { ok: true };
    });
    // 커밋이 끝난 뒤에만 백업한다. 응답을 늦추지 않도록 기다리지 않는다.
    if (approvedVersion && onMonthlyApproved) {
      Promise.resolve().then(() => onMonthlyApproved(approvedVersion))
        .catch(error => console.error('월 확정 백업 실패:', error));
    }
    return result;
  }
  // 신청자 본인이 자신의 대기·확정 건을 취소한다. decide()와 마찬가지로 validateSave의
  // "기존 신청 불변" 규칙을 우회해 state를 직접 수정한다 — 일반 저장 경로로는 취소를 반영할 수 없다.
  function cancelOwn(req) {
    const { kind, id } = req.body || {};
    if (!['request', 'protect'].includes(kind) || typeof id !== 'string' || !id) fail(400, '요청 형식을 확인해주세요.');
    touch(req);
    const employeeId = isEmployee(req);
    if (!employeeId) fail(401, '로그인이 필요합니다.');
    return transaction(() => {
      const row = getState(), state = row?.state;
      const items = kind === 'request' ? state?.requests : state?.protects;
      const item = items?.find(x => x.id === id);
      if (!item) fail(404, '신청을 찾을 수 없습니다.');
      if (item.empId !== employeeId) fail(403, '본인 신청만 취소할 수 있습니다.');
      const at = new Date().toISOString();
      // 확정된 휴가는 바로 지우지 않고 '취소 신청'을 담당자 승인함에 올린다. 승인되면 decide()가 취소한다.
      // 담당자가 한 명도 없으면(신청도 승인 없이 확정되는 구성) 바로 취소한다.
      const confirmedLeave = kind === 'request' && item.status === 'confirmed';
      if (confirmedLeave) {
        if (String(item.startDate) < kstToday()) fail(409, '이미 지난 휴가는 취소할 수 없습니다.');
        if (state.approvals?.some(a => a.type === 'leave-cancel' && a.refId === id && a.status === 'pending')) fail(409, '이미 취소 승인을 기다리고 있습니다.');
        const approverIds = targets(state);
        if (approverIds.length) {
          state.approvals ||= [];
          const name = employeeName(state, item.empId, item.empId);
          const approval = {
            id: 'cancelreq_' + randomBytes(12).toString('hex'), type: 'leave-cancel', refId: id, requestedBy: employeeId,
            title: `${name} — ${item.startDate} 휴가 취소 신청`,
            summary: (Array.isArray(item.chain) ? item.chain : []).map(c => `${c.date} ${employeeName(state, c.empId, c.empId)}: ${c.label} → 원래 근무로`).join('\n'),
            status: 'pending', requestedAt: at, approverIds, decidedBy: null, decidedAt: null, decisionReason: ''
          };
          state.approvals.unshift(approval);
          state.auditLogs ||= [];
          state.auditLogs.unshift({ id: 'cancel_' + randomBytes(12).toString('hex'), action: '휴가 취소 신청', details: { id, empId: employeeId }, at });
          persist(state, row);
          activityLog.logCancelRequest(state, item);
          return { ok: true, pendingApproval: true, approvalId: approval.id };
        }
      } else if (item.status !== 'pending') fail(409, '이미 처리되었거나 취소할 수 없는 상태입니다.');
      item.status = 'cancelled';
      item.cancelledAt = at;
      const approvalType = kind === 'request' ? 'leave' : 'protect';
      const approval = state.approvals?.find(a => a.type === approvalType && a.refId === id && a.status === 'pending');
      if (approval) Object.assign(approval, { status: 'rejected', decidedBy: null, decidedAt: at, decisionReason: '신청자 본인 취소' });
      state.auditLogs ||= [];
      state.auditLogs.unshift({
        id: 'cancel_' + randomBytes(12).toString('hex'),
        action: kind === 'request' ? '휴가 신청 본인 취소' : '비번 보장 신청 본인 취소',
        details: { id, empId: employeeId }, at
      });
      persist(state, row);
      activityLog.logSelfCancel(state, kind, item);
      return { ok: true };
    });
  }
  // 편집 잠금: 시스템 관리자·직원·근무표를 편집하는 승인 담당자 중 한 명만 동시에 편집한다.
  // 관리자·직원은 로그인할 때, 승인 담당자는 근무표 편집 패널을 열 때 잠금을 잡는다. 세션처럼 서버 메모리에만 두고 하트비트로 유지하며,
  // 하트비트가 LOCK_TIMEOUT_MS 이상 끊기면(탭을 닫았거나 네트워크가 끊긴 경우) 자동 해제된다.
  let lock = null; // { holderKey, holderName, acquiredAt, heartbeatAt }
  const LOCK_TIMEOUT_MS = Number(process.env.LOCK_TIMEOUT_MS) || 3 * 60 * 1000;
  function activeLock() {
    if (lock && Date.now() - lock.heartbeatAt > LOCK_TIMEOUT_MS) lock = null;
    return lock;
  }
  function callerKey(req) {
    if (isAdmin(req)) return { key: 'admin', name: '시스템 관리자' };
    const empId = isEmployee(req);
    if (empId) {
      const name = getState()?.state?.employees?.find(e => e.id === empId)?.name || '직원';
      return { key: 'employee:' + empId, name };
    }
    const approverId = approverSession(req);
    if (approverId) {
      const name = getState()?.state?.approvers?.find(a => a.id === approverId)?.name || '담당자';
      return { key: 'approver:' + approverId, name: name + ' 담당자' };
    }
    return null;
  }
  function lockStatus() {
    const l = activeLock();
    return l ? { locked: true, holderName: l.holderName } : { locked: false };
  }
  function acquireLock(req) {
    const who = callerKey(req);
    if (!who) fail(401, '로그인이 필요합니다.');
    const l = activeLock();
    if (l && l.holderKey !== who.key) fail(409, `${l.holderName}님이 편집 중입니다. 편집이 끝난 뒤 다시 시도해주세요.`);
    lock = { holderKey: who.key, holderName: who.name, acquiredAt: l?.acquiredAt || Date.now(), heartbeatAt: Date.now() };
    return { ok: true, holderName: who.name };
  }
  function heartbeatLock(req) {
    const who = callerKey(req);
    const l = activeLock();
    if (!who || !l || l.holderKey !== who.key) fail(409, '편집 잠금이 끊어졌습니다. 새로고침 후 다시 시작해주세요.');
    l.heartbeatAt = Date.now();
    return { ok: true };
  }
  function releaseLock(req) {
    // 탭을 닫을 때 sendBeacon으로도 호출되는데, 그 경우 커스텀 헤더를 못 실어 보내므로
    // 본문(body)에 담아 보낸 토큰도 같은 방식으로 인식해준다.
    const withBodyFallback = {
      get: header => req.get(header) || { 'X-Admin-Token': req.body?.adminToken, 'X-Employee-Token': req.body?.employeeToken, 'X-Approver-Token': req.body?.approverToken }[header]
    };
    const who = callerKey(withBodyFallback);
    const l = activeLock();
    if (l && (!who || l.holderKey === who.key)) lock = null;
    return { ok: true };
  }
  return { login, touch, save, decide, isAdmin, isManager, employeeSession, employeeLogin, changeEmployeePin, approverLogin, cancelOwn, lockStatus, acquireLock, heartbeatLock, releaseLock };
}
module.exports = { createSecurity, publicState, validateSave, targets };
