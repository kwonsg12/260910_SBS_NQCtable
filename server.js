// 통합관제실 근무표 시스템 — 사내망 서버 (Phase 1: 공유 저장소)
//
// 기존에는 index.html이 브라우저 localStorage에만 데이터를 저장해 PC마다
// 근무표/신청 내역이 따로 보였다. 이 서버는 정적 파일을 그대로 서빙하면서
// /api/state 로 같은 데이터를 모든 브라우저가 공유하도록 한다.
//
// 실행: node server.js  (또는 npm start)
// 사내망 접속: http://<이 PC의 내부 IP>:PORT

require('dotenv').config();
const path = require('path');
const express = require('express');
const { db, getState, setState, backupTo } = require('./db');
const { createSecurity, publicState, targets } = require('./security');
const { readFileSync, existsSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { notifyApprovers, getBaseUrl } = require('./notifier');
const { startDigestScheduler } = require('./digest');
const { createWorkbook } = require('./excel-export');
const { createMyScheduleMailer } = require('./my-schedule-mail');
const { saveMonthlyBackup, startBackupScheduler } = require('./backup');

const app = express();
// A local HTTPS reverse proxy may forward the original protocol.
app.set('trust proxy', 'loopback');
const PORT = Number(process.env.PORT) || 8000;
// 월 근무표 확정이 승인되면 서버 PC 에 엑셀·JSON 확정본을 남긴다(backup.js).
const security = createSecurity({ db, getState, setState, onMonthlyApproved: version => saveMonthlyBackup(version) });
const mailMySchedule = createMyScheduleMailer({ getState, security });
// 화면 안의 <script> 만 실행을 허락한다(CSP 해시). 근무표와 교대 앱(shift/) 두 화면이다.
// shift/ 가 없는 복사본(테스트 등)에서도 서버는 떠야 하므로 없으면 건너뛴다.
function inlineScriptHashes(file) {
  const full = path.join(__dirname, file);
  if (!existsSync(full)) return [];
  return [...readFileSync(full, 'utf8').replace(/\r\n?/g, '\n').matchAll(/<script>([\s\S]*?)<\/script>/g)]
    .map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");
}
const scriptHashes = [...inlineScriptHashes('index.html'), ...inlineScriptHashes('shift/index.html')];

app.use(express.json({ limit: '15mb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Security-Policy', "script-src 'self' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net " + scriptHashes.join(' ') + "; script-src-attr 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (req.path.startsWith('/api/')) {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST' && req.get('Origin') && req.get('Origin') !== req.protocol + '://' + req.get('Host')) {
      return res.status(403).json({ error: '다른 사이트에서 보낸 요청은 허용하지 않습니다.' });
    }
  }
  next();
});

// 프로젝트 폴더에는 DB·로그·서버 코드도 있으므로 폴더 전체를 공개하지 않는다.
// 브라우저에서 사용할 파일을 추가할 때는 이 목록에 URL과 파일명을 명시한다.
const publicFiles = new Map([
  ['/', 'index.html'],
  ['/index', 'index.html'],
  ['/index.html', 'index.html'],
  ['/sbs-logo.png', 'sbs-logo.png'],
  // 교대 앱(NQCshift "교대온 간단"): 메일로 받은 내 근무표 CSV 를 휴대폰에서 오늘·내일·달력으로 본다.
  // 사내망 예비 주소 http://<서버>/shift/. 메일 링크는 팀 GitHub Pages(SHIFT_APP_URL). 원본은 github.com/sbsnqc4821/NQCshift.
  ['/shift/', 'shift/index.html'],
  ['/shift/index.html', 'shift/index.html'],
  ['/shift/manifest.webmanifest', 'shift/manifest.webmanifest'],
  ['/shift/sw.js', 'shift/sw.js'],
  ['/shift/icons/apple-touch-icon.png', 'shift/icons/apple-touch-icon.png'],
  ['/shift/icons/icon-192.png', 'shift/icons/icon-192.png'],
  ['/shift/icons/icon-512.png', 'shift/icons/icon-512.png'],
  ['/shift/icons/icon-maskable-512.png', 'shift/icons/icon-maskable-512.png']
]);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  // 앱 안의 상대 경로(manifest.webmanifest, icons/…)가 맞게 풀리도록 끝에 / 를 붙여 보낸다.
  if (req.path === '/shift') return res.redirect(301, '/shift/');
  const file = publicFiles.get(req.path);
  if (!file) return next();
  res.sendFile(path.join(__dirname, file), file.endsWith('.webmanifest')
    ? { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } } : undefined);
});

app.post('/api/auth/admin', (req, res) => res.json(security.login(req)));
app.post('/api/auth/employee', (req, res) => res.json(security.employeeLogin(req)));
app.post('/api/auth/employee/pin', (req, res) => res.json(security.changeEmployeePin(req)));
app.post('/api/auth/approver', (req, res) => res.json(security.approverLogin(req)));
app.post('/api/approvals/decision', (req, res) => res.json(security.decide(req)));
app.post('/api/requests/cancel', (req, res) => res.json(security.cancelOwn(req)));

// 편집 잠금: 관리자/직원 중 한 명만 동시에 편집하게 막는다. 상태 조회는 로그인 없이도
// 볼 수 있어야 로그인 전에 "OOO님이 편집 중"임을 미리 안내할 수 있다.
app.get('/api/lock', (req, res) => res.json(security.lockStatus()));
app.post('/api/lock/acquire', (req, res) => res.json(security.acquireLock(req)));
app.post('/api/lock/heartbeat', (req, res) => res.json(security.heartbeatLock(req)));
app.post('/api/lock/release', (req, res) => res.json(security.releaseLock(req)));

// 화면에 표시된 근무값으로 다운로드만 생성하며 공유 상태는 변경하지 않는다.
app.post('/api/export/excel', async (req, res) => {
  try {
    const buffer = await createWorkbook(req.body);
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Cache-Control', 'no-store');
    res.attachment(`schedule-${req.body.year}-${String(req.body.month).padStart(2, '0')}.xlsx`);
    res.send(buffer);
  } catch (error) {
    if (!error.status) console.error('엑셀 생성 오류:', error);
    res.status(error.status || 500).json({error:error.status ? error.message : '엑셀 파일을 생성하지 못했습니다. 잠시 후 다시 시도해 주세요.'});
  }
});

// 로그인한 근무자 본인의 한 달 근무를 CSV 로 그 사람의 등록된 사내메일에 보낸다.
// 받는 주소는 서버가 로그인 토큰으로 정한다 (my-schedule-mail.js).
app.post('/api/my-schedule/mail', async (req, res, next) => {
  try { res.json(await mailMySchedule(req)); } catch (error) { next(error); }
});

// 현재 저장된 근무표 상태 전체를 반환. 서버에 아직 아무것도 없으면 state:null
// (이 경우 index.html은 기본값으로 초기화한다).
app.get('/api/state', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const row = getState();
  res.json({ state: row ? publicState(row.state) : null, updatedAt: row ? row.updatedAt : null, revision: row ? row.revision : 0 });
});

// 검증·PIN 보호·버전 충돌 처리는 security.save가 전담한다.
app.post('/api/state', (req, res) => {
  res.json(security.save(req));
});

// 승인 요청이 생기면 브라우저가 이 엔드포인트를 호출한다. 실제 메일 발송은
// notifier가 담당하며, 설정이 안 되어 있으면 콘솔 로그만 남기고 넘어간다.
const notificationTimes = new Map();
app.post('/api/notify', async (req, res, next) => {
  try {
    const state = getState()?.state;
    const approval = state?.approvals?.find(a => a.id === req.body?.approval?.id);
    if (!approval || approval.status !== 'pending') return res.status(400).json({ error: '저장된 승인 대기 건만 알림을 보낼 수 있습니다.' });
    const now = Date.now();
    for (const [id, time] of notificationTimes) if (now - time >= 60000) notificationTimes.delete(id);
    if (notificationTimes.has(approval.id)) return res.status(429).json({ error: '이 신청의 알림을 방금 보냈습니다.' });
    notificationTimes.set(approval.id, now);
    const allowed = targets(state, approval.requestedBy);
    const approvers = state.approvers.filter(a => allowed.includes(a.id) && approval.approverIds.includes(a.id));
    const results = await notifyApprovers({
      ...approval, requestedByName: state.employees?.find(e => e.id === approval.requestedBy)?.name || ''
    }, approvers);
    res.json({ ok: true, results });
  } catch (error) { next(error); }
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  const status = error.status || 500;
  res.status(status).json({ error: status < 500 ? error.message : (status === 503 ? error.message : '서버 처리에 실패했습니다.') });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`근무표 서버 실행 중 — http://localhost:${PORT}`);
  console.log(`사내망 접속 주소: ${getBaseUrl()}  (승인 메일의 링크도 이 주소로 나갑니다)`);
  console.log(process.env.SMTP_HOST
    ? `메일 발송: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 25}`
    : '메일 발송: 미설정 (.env에 SMTP_HOST를 넣으면 활성화됩니다)');
  startDigestScheduler();
  startBackupScheduler({ backupTo });
});
