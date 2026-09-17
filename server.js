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
const { getState, setState } = require('./db');
const { notifyApprovers, getBaseUrl } = require('./notifier');

const app = express();
const PORT = Number(process.env.PORT) || 8000;

app.use(express.json({ limit: '15mb' }));

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

// 현재 저장된 근무표 상태 전체를 반환. 서버에 아직 아무것도 없으면 state:null
// (이 경우 index.html은 기본값으로 초기화한다).
app.get('/api/state', (req, res) => {
  const row = getState();
  res.json({ state: row ? row.state : null, updatedAt: row ? row.updatedAt : null });
});

// 근무표 상태 전체를 덮어써 저장한다. index.html의 saveState()가 STATE 전체를
// 그대로 보내온다 (localStorage.setItem 하던 자리를 대체).
app.post('/api/state', (req, res) => {
  const state = req.body && req.body.state;
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    return res.status(400).json({ error: 'invalid state payload' });
  }
  const updatedAt = setState(state);
  res.json({ ok: true, updatedAt });
});

// 승인 요청이 생기면 브라우저가 이 엔드포인트를 호출한다. 실제 사내메일/카카오톡
// 발송은 notifier가 담당하며, 설정이 안 되어 있으면 콘솔 로그만 남기고 넘어간다.
app.post('/api/notify', async (req, res) => {
  const { approval, approvers } = req.body || {};
  if (!approval || !Array.isArray(approvers)) {
    return res.status(400).json({ error: 'invalid notify payload' });
  }
  const results = await notifyApprovers(approval, approvers);
  res.json({ ok: true, results });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`근무표 서버 실행 중 — http://localhost:${PORT}`);
  console.log(`사내망 접속 주소: ${getBaseUrl()}  (승인 메일의 링크도 이 주소로 나갑니다)`);
  console.log(process.env.SMTP_HOST
    ? `사내메일 발송: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || 25}`
    : '사내메일 발송: 미설정 (.env에 SMTP_HOST를 넣으면 활성화됩니다)');
  console.log(String(process.env.KAKAO_AUTOMATION || '').toLowerCase() === 'true'
    ? '카카오톡 자동 발송: 활성 (KakaoTalk 데스크톱이 로그인되어 있어야 합니다)'
    : '카카오톡 자동 발송: 미설정 (.env에 KAKAO_AUTOMATION=true)');
});
