// 사람이 바로 읽을 수 있는 활동 로그를 날짜별 txt 파일로 로컬에 남긴다.
// geunmupyo.db(SQLite)와는 별개로, 육안으로 빠르게 훑어보거나 따로 백업·전달하기 위한 용도다.
// 휴가 신청·비번 보장 신청·대근 불가 사유 "제출"은 save()가 새로 생긴 항목을 찾아 기록하고,
// 승인/반려/본인 취소는 decide()/cancelOwn()이 처리 시점에 직접 기록한다.

const fs = require('node:fs');
const path = require('node:path');

const LOG_DIR = path.join(__dirname, 'logs');

function todayFile(date = new Date()) {
  const y = date.getFullYear(), m = String(date.getMonth() + 1).padStart(2, '0'), d = String(date.getDate()).padStart(2, '0');
  return path.join(LOG_DIR, `${y}-${m}-${d}.txt`);
}

function appendLines(lines) {
  if (!lines || !lines.length) return;
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toLocaleString('ko-KR', { hour12: false });
  fs.appendFileSync(todayFile(), lines.map(line => `[${stamp}] ${line}\n`).join(''), 'utf8');
}

function empName(state, id) {
  return state?.employees?.find(e => e.id === id)?.name || id || '알 수 없음';
}
function leaveStatusLabel(r) {
  if (r.status === 'pending') return '승인 대기';
  if (r.status === 'confirmed') return '확정';
  return r.cancelledAt ? '본인 취소' : '반려';
}
function protectStatusLabel(p) {
  if (p.status === 'pending') return '승인 대기';
  if (p.status === 'approved') return p.needsApproval ? '승인' : '확정';
  return p.status === 'cancelled' ? '본인 취소' : '반려';
}

// save() 저장이 끝난 뒤 호출한다. 기존에 없던(id가 새로운) 신청/사유만 새 제출로 보고 기록한다.
function logNewSubmissions(oldState, newState) {
  const idsOf = arr => new Set((arr || []).map(x => x.id));
  const added = (oldArr, newArr) => { const ids = idsOf(oldArr); return (newArr || []).filter(x => !ids.has(x.id)); };
  const lines = [];
  for (const r of added(oldState?.requests, newState.requests)) {
    lines.push(`휴가 신청 — ${empName(newState, r.empId)} / ${r.startDate} (${r.type === 'day' ? '일근' : '야+조'}) / ${leaveStatusLabel(r)}`);
  }
  for (const p of added(oldState?.protects, newState.protects)) {
    lines.push(`비번 보장 신청 — ${empName(newState, p.empId)} / ${p.date} / ${protectStatusLabel(p)}`);
  }
  for (const x of added(oldState?.excuses, newState.excuses)) {
    lines.push(`대근 불가 사유 — ${empName(newState, x.empId)} / ${x.date}: ${x.reason}`);
  }
  appendLines(lines);
}

// decide()에서 승인/반려가 확정된 직후 호출한다.
function logDecision(state, approval, approved, actorName, reason) {
  const typeLabel = { leave: '휴가 신청', protect: '비번 보장 신청', monthly: '월간 근무표 확정' }[approval.type] || approval.type;
  const target = approval.type === 'monthly' ? approval.refId : empName(state, approval.requestedBy);
  appendLines([`${typeLabel} ${approved ? '승인' : '반려'} — 대상: ${target} / 처리자: ${actorName}${reason ? ` / 사유: ${reason}` : ''}`]);
}

// cancelOwn()에서 본인 취소가 반영된 직후 호출한다.
function logSelfCancel(state, kind, item) {
  const typeLabel = kind === 'request' ? '휴가 신청' : '비번 보장 신청';
  appendLines([`${typeLabel} 본인 취소 — ${empName(state, item.empId)} / ${kind === 'request' ? item.startDate : item.date}`]);
}

module.exports = { LOG_DIR, todayFile, appendLines, logNewSubmissions, logDecision, logSelfCancel };
