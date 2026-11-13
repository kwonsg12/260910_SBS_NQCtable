// 내 근무표 메일 — 로그인한 근무자가 보고 있는 달의 본인 근무를 CSV 로 받는다.
//
// 받는 주소는 **서버가 정한다**: 로그인 토큰의 직원에게 등록된 사내메일(직원 구성의 email)
// 하나뿐이다. 요청 본문에 주소를 넣어도 쓰지 않는다 — 남의 주소로 근무표를 보내는 통로가
// 되면 안 된다.
//
// 근무값은 화면이 계산해서 보낸다(엑셀 내보내기와 같다). 근무 계산(로테이션·휴가·대근·
// 수동 편집)은 index.html 에만 있어서다. 본인 메일로만 가므로 값이 틀려도 본인만 받는다.

const { sendMail, isMailConfigured } = require('./notifier');

// 같은 사람이 버튼을 연달아 눌러 메일이 쌓이지 않게 한다.
const RESEND_MS = 60 * 1000;

function fail(status, message) { throw Object.assign(new Error(message), { status }); }

// 화면의 근무값 → 파일의 근무값. 비번만 비 로 바꾸고 나머지(일·야·조·휴가·대일…)는 그대로.
// 휴가를 '휴' 로 줄이지 않는다: 이 CSV 를 불러오는 교대 앱(NQCshift)은 '휴' 를 비번(휴무)으로
// 읽어서 휴가가 그냥 쉬는 날로 보였다 (2026-11-13 사용자 확인).
function shiftLabel(value) {
  if (value === 'O') return '비';
  return value;
}

// 엑셀에서 = + - @ 로 시작하는 칸은 수식으로 실행될 수 있어 앞에 ' 를 붙인다.
function csvCell(value) {
  let text = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// 1일부터 말일까지 한 줄씩: 날짜, 근무 (사용자가 두 칸만 원했다). 엑셀이 한글을 깨뜨리지 않게 BOM 을 붙인다.
function buildScheduleCsv({ year, month, shifts }) {
  const lines = ['날짜,근무'];
  shifts.forEach((shift, index) => {
    const day = index + 1;
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    lines.push([date, shiftLabel(shift)].map(csvCell).join(','));
  });
  return '﻿' + lines.join('\r\n') + '\r\n';
}

function validate(body) {
  const { year, month, shifts } = body || {};
  if (!Number.isInteger(year) || year < 2000 || year > 2100) fail(400, '연도를 확인해주세요.');
  if (!Number.isInteger(month) || month < 1 || month > 12) fail(400, '월을 확인해주세요.');
  if (!Array.isArray(shifts) || shifts.length !== daysInMonth(year, month)) fail(400, '그 달의 날짜 수만큼 근무값이 있어야 합니다.');
  for (const shift of shifts) {
    if (typeof shift !== 'string' || shift.length > 20 || /[\u0000-\u001f\u007f]/.test(shift)) fail(400, '근무값 형식을 확인해주세요.');
  }
  return { year, month, shifts };
}

function createMyScheduleMailer({ getState, security, send = sendMail, mailReady = isMailConfigured, now = () => Date.now() }) {
  const lastSent = new Map();

  return async function mailMySchedule(req) {
    const session = security.employeeSession(req);
    if (!session) fail(401, '로그인이 필요합니다.');
    if (session.mustChange) fail(403, '처음 PIN(0000)을 바꾼 뒤에 쓸 수 있어요.');
    const { year, month, shifts } = validate(req.body);

    const employee = getState()?.state?.employees?.find(e => e.id === session.empId);
    if (!employee) fail(404, '직원 정보를 찾지 못했습니다.');
    const to = String(employee.email || '').trim();
    if (!to) fail(400, '등록된 사내메일이 없습니다. 관리자에게 직원 구성에서 메일 등록을 요청해주세요.');
    if (!mailReady()) fail(503, '서버에 메일 설정이 없어 보낼 수 없습니다. 관리자에게 문의해주세요.');

    const at = now();
    for (const [id, time] of lastSent) if (at - time >= RESEND_MS) lastSent.delete(id);
    if (lastSent.has(session.empId)) fail(429, '방금 보냈어요. 1분 뒤에 다시 눌러주세요.');
    lastSent.set(session.empId, at);

    const name = employee.name || '';
    const csv = buildScheduleCsv({ year, month, shifts });
    const summary = shifts.map((shift, index) => `${index + 1}일 ${shiftLabel(shift) || '-'}`).join(' · ');
    const result = await send(
      to,
      `[근무표] ${year}년 ${month}월 ${name}님 근무`,
      `${name}님의 ${year}년 ${month}월 근무표입니다. 첨부한 CSV 파일을 엑셀이나 달력 앱에서 열 수 있습니다.\n\n${summary}\n\n(근무표에서 [내 근무표 메일로] 를 눌러 보낸 메일입니다.)\n`,
      undefined,
      [{ filename: `근무표_${year}-${String(month).padStart(2, '0')}_${name}.csv`, content: csv, contentType: 'text/csv; charset=utf-8' }]
    );
    if (!result.ok) {
      lastSent.delete(session.empId);
      // 503 은 오류 처리기가 문구를 그대로 화면에 넘긴다(500 대 다른 코드는 일반 문구로 바뀐다).
      fail(503, '메일을 보내지 못했습니다. 잠시 뒤 다시 시도해주세요.');
    }
    console.log(`[내 근무표] ${name} ${year}-${month} → ${to}`);
    return { ok: true, to };
  };
}

module.exports = { createMyScheduleMailer, buildScheduleCsv, shiftLabel };
