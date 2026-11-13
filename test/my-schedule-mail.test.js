const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createMyScheduleMailer, buildScheduleCsv } = require('../my-schedule-mail');

// 내 근무표 메일: 받는 주소는 로그인한 본인 것뿐, CSV 는 1일~말일 한 줄씩.
// 실제 메일은 보내지 않는다 — send 를 가짜로 바꿔 무엇을 보냈는지만 본다.

const NOV = Array.from({ length: 30 }, (_, i) => ['일', '야', '조', 'O'][i % 4]);
NOV[11] = '휴가';
NOV[12] = '대일';

function setup({ session = { empId: 'e1', mustChange: false }, email = 'me@example.invalid', ready = true, ok = true } = {}) {
  const sent = [];
  let clock = 1_000_000;
  const state = { employees: [{ id: 'e1', name: '최도인', email }, { id: 'e2', name: '양명국', email: 'other@example.invalid' }] };
  const mail = createMyScheduleMailer({
    getState: () => ({ state }),
    security: { employeeSession: () => session },
    send: async (...args) => { sent.push(args); return { ok }; },
    mailReady: () => ready,
    now: () => clock
  });
  return { mail, sent, tick: ms => { clock += ms; } };
}
const req = body => ({ body: { year: 2026, month: 11, shifts: NOV, ...body } });

async function rejects(promise, status, pattern) {
  await assert.rejects(promise, error => error.status === status && (!pattern || pattern.test(error.message)));
}

test('CSV: 1일부터 말일까지 날짜·근무 두 칸, 비번은 비, 휴가는 휴가 그대로, BOM 포함', () => {
  const csv = buildScheduleCsv({ year: 2026, month: 11, shifts: NOV });
  assert.ok(csv.startsWith('﻿날짜,근무\r\n'));
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines.length, 31);
  assert.equal(lines[1], '2026-11-01,일');
  assert.equal(lines[4], '2026-11-04,비');
  assert.equal(lines[12], '2026-11-12,휴가');
  assert.equal(lines[13], '2026-11-13,대일');
  assert.equal(lines[30], '2026-11-30,야');
  assert.ok(lines.every(line => line.split(',').length === 2), '날짜·근무 두 칸이어야 한다');
});

test('CSV: 엑셀 수식처럼 보이는 값과 쉼표는 안전하게 적는다', () => {
  const csv = buildScheduleCsv({ year: 2026, month: 2, shifts: Array.from({ length: 28 }, (_, i) => i === 0 ? '=1+1' : i === 1 ? '경조,휴가' : '') });
  assert.match(csv, /2026-02-01,'=1\+1/);
  assert.match(csv, /2026-02-02,"경조,휴가"/);
});

test('로그인한 본인의 등록된 메일로만 보낸다 — 본문의 주소는 무시', async () => {
  const { mail, sent } = setup();
  const result = await mail(req({ to: 'attacker@example.invalid', empId: 'e2' }));
  assert.deepEqual(result, { ok: true, to: 'me@example.invalid' });
  assert.equal(sent.length, 1);
  const [to, subject, text, , attachments] = sent[0];
  assert.equal(to, 'me@example.invalid');
  assert.match(subject, /2026년 11월 최도인님 근무/);
  assert.match(text, /1일 일 · 2일 야/);
  assert.equal(attachments[0].filename, '근무표_2026-11_최도인.csv');
  assert.match(attachments[0].content, /2026-11-12,휴가/);
});

test('로그인 안 함 401, 처음 PIN 그대로면 403', async () => {
  await rejects(setup({ session: null }).mail(req()), 401);
  await rejects(setup({ session: { empId: 'e1', mustChange: true } }).mail(req()), 403, /PIN/);
});

test('메일 미등록 400, 서버 메일 설정 없음 503, 발송 실패 503', async () => {
  await rejects(setup({ email: '' }).mail(req()), 400, /사내메일/);
  await rejects(setup({ ready: false }).mail(req()), 503, /메일 설정/);
  await rejects(setup({ ok: false }).mail(req()), 503, /보내지 못했/);
});

test('날짜 수가 안 맞거나 값이 이상하면 거절', async () => {
  const { mail, sent } = setup();
  await rejects(mail(req({ shifts: NOV.slice(0, 29) })), 400);
  await rejects(mail(req({ month: 13 })), 400);
  await rejects(mail(req({ shifts: NOV.map((s, i) => i === 0 ? 'x'.repeat(21) : s) })), 400);
  await rejects(mail(req({ shifts: NOV.map((s, i) => i === 0 ? '일\n' : s) })), 400);
  assert.equal(sent.length, 0);
});

test('1분 안에 다시 누르면 429, 1분 지나면 다시 보낸다. 실패한 건 바로 다시 보낼 수 있다', async () => {
  const { mail, sent, tick } = setup();
  await mail(req());
  await rejects(mail(req()), 429);
  tick(60 * 1000);
  await mail(req());
  assert.equal(sent.length, 2);

  const failing = setup({ ok: false });
  await rejects(failing.mail(req()), 503);
  await rejects(failing.mail(req()), 503);
  assert.equal(failing.sent.length, 2, '실패한 뒤에도 1분을 기다리게 했다');
});

test('화면: 버튼은 처음에 숨어 있고, 근무자 로그인일 때만 보이며, 인라인 핸들러가 없다', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /<button[^>]*id="mailMyScheduleBtn"[^>]*hidden/);
  assert.match(html, /mailBtn\.hidden = !employeeLoggedIn/);
  assert.match(html, /\$\('#mailMyScheduleBtn'\)\.addEventListener\('click', mailMySchedule\)/);
  assert.ok(!html.includes('onclick='));
});
