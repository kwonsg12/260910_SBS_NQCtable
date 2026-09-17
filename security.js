const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');
const { isDeepStrictEqual: equal } = require('node:util');

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
function targets(state, empId) {
  const all = list(state, 'approvers');
  if (empId === null) return all.map(a => a.id);
  const emp = list(state, 'employees').find(e => e.id === empId);
  return all.filter(a => {
    const scope = String(a.scope || '').trim();
    return !scope || scope === 'all' || scope === '전체' || scope.split(/[,\s]+/).some(t => t === empId || t === emp?.name);
  }).map(a => a.id);
}
function validateSave(previous, incoming, admin) {
  validateTree(incoming);
  const next = publicState(incoming), old = publicState(previous || {});
  for (const key of ['employees', 'approvers', 'requests', 'protects', 'approvals']) list(next, key);
  if (!next.settings || typeof next.settings !== 'object' || Array.isArray(next.settings)) fail(400, '설정 형식이 잘못되었습니다.');
  if (!Number.isInteger(next.settings.quotaMax) || next.settings.quotaMax < 1 || next.settings.quotaMax > 31) fail(400, '보장 횟수는 1~31 정수여야 합니다.');
  if (!previous && !admin) fail(403, '최초 공유 저장소 설정은 관리자 인증이 필요합니다.');
  if (!admin) {
    for (const key of ['settings', 'employees', 'approvers', 'scheduleOverrides', 'scheduleSnapshots', 'scheduleRanges', 'rotationAnchors', 'deletedEmployeesTrash', 'versions']) {
      if (!equal(old[key], next[key])) fail(403, '설정·직원·수동 근무 변경은 관리자 인증이 필요합니다.');
    }
  }
  // Even administrators must use the decision endpoint. Old approvals cannot be removed/replaced.
  if (!equal(old.monthlyApprovals || {}, next.monthlyApprovals || {})) fail(409, '월 확정은 승인함에서 처리해주세요.');
  for (const key of ['requests', 'protects', 'approvals']) {
    for (const before of list(old, key)) {
      if (!equal(before, list(next, key).find(item => item.id === before.id))) fail(409, '기존 신청/승인이 변경되었습니다. 새로고침 후 다시 시도하세요.');
    }
  }
  const added = key => list(next, key).filter(item => !list(old, key).some(before => before.id === item.id));
  if (!equal(old.approvers, next.approvers)) {
    for (const approval of list(old, 'approvals').filter(a => a.status === 'pending')) {
      if (!targets(next, approval.requestedBy).some(id => approval.approverIds?.includes(id))) {
        fail(409, '대기 중인 신청을 처리할 담당자가 없어집니다. 먼저 승인을 처리하거나 담당 범위를 확인해주세요.');
      }
    }
  }
  for (const req of added('requests')) {
    if (!list(next, 'employees').some(e => e.id === req.empId)) fail(400, '신청 직원이 없습니다.');
    if (req.status !== (list(next, 'approvers').length ? 'pending' : 'confirmed')) fail(403, '휴가 승인 결과를 직접 지정할 수 없습니다.');
    if (!Array.isArray(req.chain) || !/^\d{4}-\d{2}-\d{2}$/.test(req.startDate)) fail(400, '휴가 신청 형식을 확인해주세요.');
  }
  const counted = [...list(old, 'protects')];
  for (const req of added('protects')) {
    if (!list(next, 'employees').some(e => e.id === req.empId) || !/^\d{4}-\d{2}-\d{2}$/.test(req.date)) fail(400, '보장 신청 직원/날짜를 확인해주세요.');
    const used = counted.filter(p => p.empId === req.empId && p.date.slice(0, 7) === req.date.slice(0, 7) && p.status !== 'cancelled').length;
    const needsApproval = used >= next.settings.quotaMax;
    if (req.status !== (needsApproval ? 'pending' : 'approved') || req.needsApproval !== needsApproval) fail(403, '비번 보장 승인 결과를 직접 지정할 수 없습니다.');
    counted.push(req);
  }
  const approvals = added('approvals');
  const seen = new Set(list(old, 'approvals').filter(a => a.status !== 'rejected').map(a => a.type + ':' + a.refId));
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
    const assigned = targets(next, approval.requestedBy);
    if (!assigned.length || !equal(approval.approverIds, assigned)) fail(400, '담당 범위에 맞는 승인 담당자를 등록해주세요.');
  }
  for (const key of ['requests', 'protects']) for (const req of added(key)) {
    const type = key === 'requests' ? 'leave' : 'protect';
    if (req.status === 'pending' && !approvals.some(a => a.type === type && a.refId === req.id)) fail(400, '승인 대기 신청에는 승인 요청이 필요합니다.');
  }
  return next;
}

function createSecurity({ db, getState, setState, adminPassword = process.env.ADMIN_PASSWORD || '' }) {
  db.exec('CREATE TABLE IF NOT EXISTS approval_credentials (id TEXT PRIMARY KEY, salt TEXT NOT NULL, hash TEXT NOT NULL)');
  const sessions = new Map(), attempts = new Map();
  const adminSalt = randomBytes(16).toString('hex');
  const adminHash = scryptSync(adminPassword, adminSalt, 32).toString('hex');
  function writePin(id, pin) {
    const salt = randomBytes(16).toString('hex');
    db.prepare('INSERT INTO approval_credentials VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET salt=excluded.salt, hash=excluded.hash').run(id, salt, scryptSync(pin, salt, 32).toString('hex'));
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
  transaction(() => {
    const row = getState();
    if (!row) return;
    const state = publicState(row.state);
    state.approvers = (row.state.approvers || []).map(a => {
      if (typeof a.pin === 'string' && a.pin && !db.prepare('SELECT id FROM approval_credentials WHERE id=?').get(a.id)) writePin(a.id, a.pin);
      return { ...publicState(a), pinConfigured: !!db.prepare('SELECT id FROM approval_credentials WHERE id=?').get(a.id) };
    });
    if (!equal(row.state, state)) persist(state, row);
  });
  function isAdmin(req) {
    const token = req.get('X-Admin-Token');
    if ((sessions.get(token) || 0) > Date.now()) return true;
    sessions.delete(token);
    return false;
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
    sessions.set(token, Date.now() + 15 * 60 * 1000);
    return { token };
  }
  function save(req) {
    return transaction(() => {
      const row = getState();
      if (row?.revision !== undefined && req.body?.baseRevision !== row.revision) fail(409, '다른 PC에서 저장했습니다. 새로고침해주세요.');
      const incoming = req.body?.state;
      if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) fail(400, 'invalid state payload');
      const admin = isAdmin(req), next = validateSave(row?.state, incoming, admin);
      const pins = req.body.approverPins || {};
      if (typeof pins !== 'object' || Array.isArray(pins)) fail(400, 'PIN 형식을 확인해주세요.');
      if (Object.keys(pins).length && !admin) fail(403, '담당자 PIN 변경은 관리자 인증이 필요합니다.');
      next.approvers = list(next, 'approvers').map(a => {
        const existing = db.prepare('SELECT id FROM approval_credentials WHERE id=?').get(a.id);
        const pin = pins[a.id];
        if (pin !== undefined) {
          if (typeof pin !== 'string' || pin.length < 6 || pin.length > 128) fail(400, '담당자 PIN은 6~128자로 입력해주세요.');
          writePin(a.id, pin);
        } else if (!existing && !list(row?.state || {}, 'approvers').some(old => old.id === a.id)) fail(400, '신규 담당자의 PIN을 설정해주세요.');
        return { ...a, pinConfigured: !!(pin || existing) };
      });
      for (const a of list(row?.state || {}, 'approvers')) if (!next.approvers.some(n => n.id === a.id)) db.prepare('DELETE FROM approval_credentials WHERE id=?').run(a.id);
      persist(next, row);
      const saved = getState();
      return { ok: true, updatedAt: saved.updatedAt, ...(saved.revision !== undefined ? { revision: saved.revision } : {}) };
    });
  }
  function decide(req) {
    const { id, approverId, pin, approved, reason = '' } = req.body || {};
    if (typeof approved !== 'boolean' || typeof reason !== 'string' || reason.length > 2000 || (!approved && !reason.trim())) fail(400, '승인 여부와 반려 사유를 확인해주세요.');
    return transaction(() => {
      const row = getState(), state = row?.state;
      const actor = state?.approvers?.find(a => a.id === approverId);
      const credentials = actor && db.prepare('SELECT salt, hash FROM approval_credentials WHERE id=?').get(actor.id);
      if (!credentials) fail(403, '담당자 PIN이 없습니다. 관리자에게 PIN 설정을 요청해주세요.');
      verify('approver:' + actor.id, pin, credentials.salt, credentials.hash);
      const approval = state.approvals.find(a => a.id === id);
      if (!approval || approval.status !== 'pending') fail(409, '이미 처리되었거나 없는 승인 요청입니다.');
      if (!approval.approverIds?.includes(actor.id) || !targets(state, approval.requestedBy).includes(actor.id)) fail(403, '이 신청을 담당하는 승인권자가 아닙니다.');
      const at = new Date().toISOString();
      if (approval.type === 'monthly') {
        state.monthlyApprovals ||= {};
        if (approved) state.monthlyApprovals[approval.refId] = { approverId: actor.id, approverName: actor.name, at };
      } else if (['leave', 'protect'].includes(approval.type)) {
        const request = state[approval.type === 'leave' ? 'requests' : 'protects']?.find(r => r.id === approval.refId);
        if (!request || request.status !== 'pending') fail(409, '신청 상태가 변경되었습니다.');
        request.status = approval.type === 'leave' ? (approved ? 'confirmed' : 'cancelled') : (approved ? 'approved' : 'rejected');
      } else fail(400, '지원하지 않는 승인 종류입니다.');
      Object.assign(approval, { status: approved ? 'approved' : 'rejected', decidedBy: actor.id, decidedAt: at, decisionReason: approved ? '' : reason.trim() });
      state.auditLogs ||= [];
      state.auditLogs.unshift({ id: 'decision_' + randomBytes(12).toString('hex'), action: approved ? '승인' : '반려', details: { approvalId: id, approverId: actor.id }, at });
      persist(state, row);
      return { ok: true };
    });
  }
  return { login, save, decide, isAdmin };
}
module.exports = { createSecurity, publicState, validateSave, targets };
