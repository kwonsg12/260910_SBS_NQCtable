// 일일 요약 메일
//
// 하루 한 번(DIGEST_TIME, 한국 시간) 지난 요약 이후 바뀐 내용을 사람별로 모아 메일로 보낸다.
//  - 근무자: 내게 배정된 대근, 내 휴가·비번 보장 신청의 처리 결과(반려 사유 포함)
//  - 담당자(관리자): 근무자들의 휴가·비번 보장 최종 상태, 대근 불가 사유 접수
// 바뀐 내용이 없는 사람에게는 보내지 않는다.
//
// 사람마다 "마지막으로 발송한 시각"(digest_cursor)을 따로 기록하므로, 발송에 실패한 사람은
// 다음 요약 때 밀린 내용까지 함께 받는다.
//
// 수동 실행: node digest.js [--dry-run] [--check]

const { db, getState } = require('./db');
const { sendMail, isMailConfigured, verifyMail, getBaseUrl } = require('./notifier');

const TZ = 'Asia/Seoul';
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const LAST_RUN_KEY = 'digest_last_run_date';

db.exec('CREATE TABLE IF NOT EXISTS digest_cursor (email TEXT PRIMARY KEY, sent_at TEXT NOT NULL)');

function kst(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  }).formatToParts(date).map(p => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, month: +parts.month, day: +parts.day };
}

function stamp(ms) {
  const d = kst(new Date(ms));
  return `${d.month}/${d.day} ${d.time}`;
}

function dayLabel(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return String(ymd);
  return `${+m[2]}월 ${+m[3]}일(${WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]})`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function validEmail(value) {
  return typeof value === 'string' && EMAIL_RE.test(value.trim());
}

function within(iso, since, until) {
  const t = Date.parse(iso);
  return Number.isFinite(t) && t > since && t <= until;
}

// state: 저장된 근무표 상태, sinceFor(email): 그 사람의 이전 발송 시각(ms), until: 이번 요약의 기준 시각(ms)
function buildDigests(state, { sinceFor, until, today, baseUrl }) {
  const employees = Array.isArray(state.employees) ? state.employees : [];
  const approvers = Array.isArray(state.approvers) ? state.approvers : [];
  const requests = Array.isArray(state.requests) ? state.requests : [];
  const protects = Array.isArray(state.protects) ? state.protects : [];
  const approvals = Array.isArray(state.approvals) ? state.approvals : [];
  const excuses = Array.isArray(state.excuses) ? state.excuses : [];
  const station = state.settings?.stationName || '통합관제실';
  const lockDay = state.settings?.lockDay || 25;

  const empName = id => employees.find(e => e.id === id)?.name || '알 수 없음';
  const decisionOf = (type, refId) => approvals.find(a => a.type === type && a.refId === refId);

  const leaveStatus = r => {
    if (r.status === 'pending') return '승인 대기';
    if (r.status === 'confirmed') return '확정';
    if (r.cancelledAt) return '본인 취소';
    const reason = decisionOf('leave', r.id)?.decisionReason;
    return '반려' + (reason ? ` (사유: ${reason})` : '');
  };
  const protectStatus = p => {
    if (p.status === 'pending') return '승인 대기';
    if (p.status === 'approved') return p.needsApproval ? '승인' : '확정';
    if (p.status === 'cancelled') return '본인 취소';
    const reason = decisionOf('protect', p.id)?.decisionReason;
    return '반려' + (reason ? ` (사유: ${reason})` : '');
  };
  const chainStatus = r => r.status === 'pending' ? '승인 대기 중 (예정 배정)' : r.status === 'confirmed' ? '확정' : '배정 해제';
  const substitutes = r => (Array.isArray(r.chain) ? r.chain : []).filter(c => c.empId !== r.empId)
    .map(c => `${dayLabel(c.date)} ${empName(c.empId)}(${c.label})`).join(', ');

  const people = new Map();
  const person = (email, name) => {
    const key = email.trim().toLowerCase();
    if (!people.has(key)) people.set(key, { email: email.trim(), name, empIds: new Set(), approverIds: new Set() });
    return people.get(key);
  };
  for (const e of employees) {
    if (validEmail(e.email) && !(e.endDate && e.endDate < today)) person(e.email, e.name).empIds.add(e.id);
  }
  for (const a of approvers) {
    if (validEmail(a.email)) person(a.email, a.name).approverIds.add(a.id);
  }

  const digests = [];
  for (const p of people.values()) {
    const since = sinceFor(p.email);
    const touched = (...times) => times.some(t => within(t, since, until));
    const leaves = requests.filter(r => touched(r.submittedAt, r.cancelledAt, decisionOf('leave', r.id)?.decidedAt));
    const pros = protects.filter(x => touched(x.submittedAt, x.cancelledAt, decisionOf('protect', x.id)?.decidedAt));
    const sections = [];
    const add = (title, rows, note) => { if (rows.length) sections.push({ title, rows, note }); };

    if (p.empIds.size) {
      const assigned = [];
      for (const r of leaves) {
        // 신청과 동시에 취소·반려된 건은 대근자가 이전에 안내받은 적이 없으므로 알리지 않는다.
        if (r.status === 'cancelled' && within(r.submittedAt, since, until)) continue;
        for (const c of Array.isArray(r.chain) ? r.chain : []) {
          if (c.empId !== r.empId && p.empIds.has(c.empId)) {
            assigned.push(`${dayLabel(c.date)} ${c.label} — ${empName(r.empId)}님 휴가 대근 [${chainStatus(r)}]`);
          }
        }
      }
      add('내게 배정된 대근', assigned,
        assigned.some(row => !row.endsWith('[배정 해제]')) ? `대근이 어려우시면 해당 월 ${lockDay}일 00시 전까지 근무표 시스템에 사유를 등록해주세요.` : '');

      const mine = [];
      for (const r of leaves.filter(r => p.empIds.has(r.empId))) {
        const subs = substitutes(r);
        mine.push(`휴가 ${dayLabel(r.startDate)} (${r.type === 'day' ? '일근' : '야+조'}) [${leaveStatus(r)}]${subs ? ` — 대근: ${subs}` : ''}`);
      }
      for (const x of pros.filter(x => p.empIds.has(x.empId))) {
        mine.push(`비번 보장 ${dayLabel(x.date)} [${protectStatus(x)}]`);
      }
      add('내 신청 처리 결과', mine);
    }

    if (p.approverIds.size) {
      const staff = [];
      for (const r of leaves.filter(r => !p.empIds.has(r.empId))) {
        const subs = substitutes(r);
        staff.push(`${empName(r.empId)} 휴가 ${dayLabel(r.startDate)} (${r.type === 'day' ? '일근' : '야+조'}) [${leaveStatus(r)}]${subs ? ` — 대근: ${subs}` : ''}`);
      }
      for (const x of pros.filter(x => x.needsApproval && !p.empIds.has(x.empId))) {
        staff.push(`${empName(x.empId)} 비번 보장(월 한도 초과) ${dayLabel(x.date)} [${protectStatus(x)}]${x.reason ? ` — 신청 사유: ${x.reason}` : ''}`);
      }
      add('근무자 휴가·비번 보장 처리 현황', staff);

      const excused = excuses.filter(e => touched(e.submittedAt) && !p.empIds.has(e.empId))
        .map(e => `${empName(e.empId)} — ${dayLabel(e.date)} 대근 불가 사유 접수: ${e.reason}`);
      add('대근 불가 사유 접수', excused);
    }

    const itemCount = sections.reduce((sum, s) => sum + s.rows.length, 0);
    if (!itemCount) { digests.push({ email: p.email, name: p.name, itemCount: 0 }); continue; }

    const pending = p.approverIds.size
      ? approvals.filter(a => a.status === 'pending' && Array.isArray(a.approverIds) && a.approverIds.some(id => p.approverIds.has(id))).length
      : 0;
    const window = `${stamp(since)} ~ ${stamp(until)}`;
    const footer = `${pending ? `현재 승인 대기 ${pending}건이 있습니다.\n` : ''}근무표 확인: ${baseUrl}`;

    const text = [
      `${p.name}님, ${station} 근무표 일일 안내입니다. (${window} 변경분)`,
      ...sections.map(s => `\n■ ${s.title}\n${s.rows.map(r => ` - ${r}`).join('\n')}${s.note ? `\n ※ ${s.note}` : ''}`),
      `\n${footer}`
    ].join('\n');
    const html = `<div style="font-family:'Malgun Gothic',Arial,sans-serif;font-size:14px;color:#1b2430;line-height:1.6;">
<p>${escapeHtml(p.name)}님, ${escapeHtml(station)} 근무표 일일 안내입니다.<br><span style="color:#6b7684;font-size:12px;">${escapeHtml(window)} 변경분</span></p>
${sections.map(s => `<h3 style="font-size:14px;margin:18px 0 6px;">■ ${escapeHtml(s.title)}</h3><ul style="margin:0;padding-left:20px;">${s.rows.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul>${s.note ? `<p style="color:#6b7684;font-size:12px;margin:4px 0 0;">※ ${escapeHtml(s.note)}</p>` : ''}`).join('\n')}
<p style="margin-top:20px;">${pending ? `현재 승인 대기 ${pending}건이 있습니다.<br>` : ''}<a href="${escapeHtml(baseUrl)}">근무표 시스템 열기</a></p>
</div>`;
    digests.push({ email: p.email, name: p.name, itemCount, subject: `[근무표] 일일 안내 ${today} (${itemCount}건)`, text, html });
  }
  return digests;
}

const setCursor = (email, ms) => db.prepare(
  'INSERT INTO digest_cursor (email, sent_at) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET sent_at = excluded.sent_at'
).run(email.toLowerCase(), new Date(ms).toISOString());

async function runDigest({ dryRun = false, now = new Date() } = {}) {
  const row = getState();
  const summary = { sent: 0, failed: 0, empty: 0 };
  if (!row) return summary;
  const until = now.getTime();
  const cursors = new Map(db.prepare('SELECT email, sent_at FROM digest_cursor').all().map(r => [r.email, Date.parse(r.sent_at)]));
  const digests = buildDigests(row.state, {
    sinceFor: email => cursors.get(email.toLowerCase()) ?? until - DAY_MS,
    until, today: kst(now).date, baseUrl: getBaseUrl()
  });
  for (const d of digests) {
    if (!d.itemCount) {
      summary.empty++;
      if (!dryRun) setCursor(d.email, until);
      continue;
    }
    if (dryRun) {
      console.log(`\n===== ${d.name} <${d.email}> — ${d.subject} =====\n${d.text}`);
      summary.sent++;
      continue;
    }
    const result = await sendMail(d.email, d.subject, d.text, d.html);
    if (result.ok) {
      setCursor(d.email, until);
      summary.sent++;
      console.log(`[요약] 발송 → ${d.name} <${d.email}> (${d.itemCount}건)`);
    } else {
      summary.failed++;
      console.log(`[요약] 실패 → ${d.name} <${d.email}>: ${result.error || result.skipped}`);
    }
  }
  return summary;
}

function startDigestScheduler() {
  if (!isMailConfigured()) {
    console.log('일일 요약 메일: 미설정 (.env에 SMTP 설정을 넣으면 활성화됩니다)');
    return;
  }
  const time = /^([01]\d|2[0-3]):[0-5]\d$/.test(process.env.DIGEST_TIME || '') ? process.env.DIGEST_TIME : '18:00';
  const getLastRun = () => db.prepare('SELECT value FROM kv_store WHERE key = ?').get(LAST_RUN_KEY)?.value ?? null;
  const setLastRun = date => db.prepare(
    'INSERT INTO kv_store (key, value, updated_at, revision) VALUES (?, ?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).run(LAST_RUN_KEY, date, new Date().toISOString());

  // 처음 켠 날 이미 발송 시각이 지났다면 오늘은 건너뛰고 다음 날 예정 시각부터 보낸다.
  const start = kst(new Date());
  if (getLastRun() === null && start.time >= time) setLastRun(start.date);

  let running = false;
  setInterval(async () => {
    const current = kst(new Date());
    if (running || current.time < time || getLastRun() === current.date) return;
    running = true;
    try {
      const summary = await runDigest();
      console.log(`[요약] ${current.date} 완료 — 발송 ${summary.sent}, 실패 ${summary.failed}, 변경 없음 ${summary.empty}`);
    } catch (error) {
      console.error('[요약] 처리 중 오류:', error.message);
    } finally {
      setLastRun(current.date);
      running = false;
    }
  }, 60 * 1000);
  console.log(`일일 요약 메일: 매일 ${time}(한국 시간)에 발송`);
}

module.exports = { buildDigests, runDigest, startDigestScheduler };

if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  (async () => {
    if (args.includes('--check')) {
      const result = await verifyMail();
      console.log(result.ok ? 'SMTP 로그인 확인 완료' : `SMTP 확인 실패: ${result.error || result.skipped}`);
      process.exit(result.ok ? 0 : 1);
    }
    const dryRun = args.includes('--dry-run');
    if (!dryRun && !isMailConfigured()) { console.log('SMTP 설정이 없습니다. .env를 확인하세요. (내용만 미리 보려면 --dry-run)'); process.exit(1); }
    const summary = await runDigest({ dryRun });
    console.log(`\n${dryRun ? '[미리보기] ' : ''}발송 ${summary.sent}, 실패 ${summary.failed}, 변경 없음 ${summary.empty}`);
  })().catch(error => { console.error(error); process.exit(1); });
}
