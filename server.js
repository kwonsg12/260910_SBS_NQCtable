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
const { db, getState, setState } = require('./db');
const { createSecurity, publicState, targets } = require('./security');
const { readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { notifyApprovers, getBaseUrl } = require('./notifier');
const { startDigestScheduler } = require('./digest');

const app = express();
// A local HTTPS reverse proxy may forward the original protocol.
app.set('trust proxy', 'loopback');
const PORT = Number(process.env.PORT) || 8000;
const security = createSecurity({ db, getState, setState });
const scriptHashes = [...readFileSync(path.join(__dirname, 'index.html'), 'utf8').replace(/\r\n?/g, '\n').matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => "'sha256-" + createHash('sha256').update(match[1]).digest('base64') + "'");

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
  ['/sbs-logo.png', 'sbs-logo.png']
]);
app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const file = publicFiles.get(req.path);
  if (!file) return next();
  res.sendFile(path.join(__dirname, file));
});

app.post('/api/auth/admin', (req, res) => res.json(security.login(req)));
app.post('/api/auth/employee', (req, res) => res.json(security.employeeLogin(req)));
app.post('/api/approvals/decision', (req, res) => res.json(security.decide(req)));
app.post('/api/requests/cancel', (req, res) => res.json(security.cancelOwn(req)));

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
});
