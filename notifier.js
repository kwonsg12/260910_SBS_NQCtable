// 메일 발송 (Gmail 공용 계정 → 사내메일)
//
// SMTP 설정(.env의 SMTP_HOST 등)이 있으면 실제로 발송하고, 비어 있으면 발송을 건너뛰고
// 콘솔에만 남긴다(개발 중에도 서버가 죽지 않도록).
//
// 승인 요청 메일(notifyApprovers)은 요청이 생긴 즉시, 변경 내용 요약(digest.js)은
// 하루 한 번 이 모듈의 sendMail로 발송한다.

const os = require('os');

let nodemailer = null;
try {
  nodemailer = require('nodemailer');
} catch (e) {
  // nodemailer 미설치 시에도 서버는 뜨게 둔다 (npm install 후 메일 기능 활성화)
}

// 사내망의 다른 PC가 접속할 수 있는 이 서버의 주소. .env의 APP_BASE_URL이 우선.
function getBaseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  const port = Number(process.env.PORT) || 8000;
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return `http://${net.address}:${port}`;
    }
  }
  return `http://localhost:${port}`;
}

let transporter = null;
function getTransporter() {
  if (transporter !== null) return transporter;
  if (!nodemailer || !process.env.SMTP_HOST) {
    transporter = false;
    return transporter;
  }
  const options = {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 25,
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true'
  };
  if (process.env.SMTP_USER) {
    options.auth = { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' };
  }
  transporter = nodemailer.createTransport(options);
  return transporter;
}

function isMailConfigured() {
  return !!getTransporter();
}

async function verifyMail() {
  const tx = getTransporter();
  if (!tx) return { ok: false, skipped: 'SMTP 설정 없음(.env의 SMTP_HOST)' };
  try {
    await tx.verify();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

async function sendMail(to, subject, text, html) {
  const tx = getTransporter();
  if (!tx) return { channel: 'email', to, ok: false, skipped: 'SMTP 설정 없음(.env의 SMTP_HOST)' };
  try {
    await tx.sendMail({
      // Gmail은 인증한 계정 주소로 발신자를 고정하므로 MAIL_FROM에는 그 주소를 써야 한다.
      from: process.env.MAIL_FROM || process.env.SMTP_USER || 'noreply@localhost',
      to,
      subject,
      text,
      ...(html ? { html } : {})
    });
    return { channel: 'email', to, ok: true };
  } catch (err) {
    return { channel: 'email', to, ok: false, error: String(err.message || err) };
  }
}

function buildMessage(approval) {
  const isApproval = !!approval.id && approval.type !== 'info';
  const who = approval.requestedByName ? `신청자: ${approval.requestedByName}\n` : '';
  const head = isApproval ? '[통합관제실 근무표] 승인 요청' : '[통합관제실 근무표] 알림';
  const tail = isApproval
    ? `아래 주소에서 승인/반려를 처리해주세요.\n${getBaseUrl()}/?approve=${encodeURIComponent(approval.id)}\n`
    : `근무표 확인: ${getBaseUrl()}\n`;
  const body = `${head}\n\n${approval.title}\n\n${who}${approval.summary || ''}\n\n${tail}`;
  return {
    subject: isApproval ? `[근무표 승인요청] ${approval.title}` : `[근무표 알림] ${approval.title}`,
    body
  };
}

async function notifyApprovers(approval, approvers) {
  const { subject, body } = buildMessage(approval);
  const results = [];
  for (const approver of approvers) {
    if (approver.email) {
      results.push(await sendMail(approver.email, subject, body));
    } else {
      results.push({ channel: 'email', to: approver.name, ok: false, skipped: '이메일 미등록' });
    }
  }
  results.forEach(r => {
    const status = r.ok ? '발송' : (r.skipped ? `건너뜀(${r.skipped})` : `실패(${r.error})`);
    console.log(`[알림] ${r.channel} → ${r.to}: ${status}`);
  });
  return results;
}

module.exports = { notifyApprovers, getBaseUrl, sendMail, isMailConfigured, verifyMail };
