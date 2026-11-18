// 화면 v2(모카 웹 대시보드) 에서 깨지기 쉬운 곳을 지킨다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Windows 에서 git 이 CRLF 로 꺼내도 같은 결과가 나오게 줄바꿈을 맞춘다 (서버도 해시 전에 맞춘다).
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8').replace(/\r\n?/g, '\n');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
const scheduleTab = html.match(/<section id="tab-schedule">[\s\S]*?<\/section>/)[0];

test('근무표 탭 안에는 section 이 하나뿐이다 (탭 전환이 main 안의 section 을 전부 숨긴다)', () => {
  assert.equal(scheduleTab.match(/<section/g).length, 1);
  assert.match(script, /\$\$\('main section'\)\.forEach\(s => s\.style\.display = 'none'\)/);
});

test('오른쪽 요약 패널은 PDF 에서 빠진다', () => {
  assert.match(scheduleTab, /<aside class="schedule-rail"[^>]*data-html2canvas-ignore="true"/);
  assert.match(script, /rail\?\.classList\.add\('export-hidden'\)/);
  assert.match(script, /rail\?\.classList\.remove\('export-hidden'\)/);
});

test('표가 주인공: 버튼 다섯 개는 [⋯ 더보기] 안에, 메뉴는 처음엔 닫혀 있고, 요약은 표 아래', () => {
  const menu = scheduleTab.match(/<div class="export-actions more-panel" id="moreActionsPanel" hidden>([\s\S]*?)<\/div>/);
  assert.ok(menu, '더보기 메뉴가 없다');
  for (const id of ['requestHistoryBtn', 'exportPdfBtn', 'exportExcelBtn', 'mailMyScheduleBtn', 'requestMonthlyBtn']) {
    assert.match(menu[1], new RegExp(`id="${id}"`), id + ' 가 더보기 안에 없다');
  }
  assert.match(scheduleTab, /id="moreActionsBtn"[^>]*aria-expanded="false"/);
  assert.match(script, /setMoreMenu\(false\)/);
  // 요약 카드(aside)는 표 카드 뒤에 온다.
  assert.ok(scheduleTab.indexOf('id="scheduleTable"') < scheduleTab.indexOf('<aside class="schedule-rail"'));
  // 제목은 PDF 에서 숨기는 달 바꾸기(schedule-nav) 밖에 있어야 PDF 에 남는다.
  const nav = scheduleTab.match(/<div class="schedule-nav"[\s\S]*?<\/div>\s*<\/div>/)[0];
  assert.ok(!nav.includes('scheduleMonthTitle'));
});

test('PDF 내보내기가 숨기는 요소가 화면에 그대로 있다', () => {
  for (const selector of ['schedule-actions-row', 'schedule-nav']) assert.match(scheduleTab, new RegExp(`class="${selector}"`));
  assert.match(scheduleTab, /id="schedulePageRoot"/);
});

test('사람별로 보기: 처음엔 로그인한 직원, [전체] 를 고르면 아무도 강조하지 않는다', () => {
  const start = script.indexOf('  let scheduleFocusEmp');
  const fn = script.slice(start, script.indexOf('  function shiftClassFor'));
  const box = {};
  const context = vm.createContext({
    $: selector => (selector === '#personFilters' ? box : null),
    escapeAttribute: value => String(value),
    employeeToken: 'token', employeeUntil: Date.now() + 60000, employeeId: 'kimk'
  });
  vm.runInContext(fn + '\nthis.focus = focusedEmployeeId;\nthis.render = renderPersonFilters;\nthis.pick = id => { scheduleFocusEmp = id; };', context);
  assert.equal(context.focus(), 'kimk', '로그인하면 내 줄이 먼저 골라져 있어야 한다');
  context.render([{ id: 'choi', name: '최도인' }, { id: 'kimk', name: '김경율' }], 'kimk');
  assert.match(box.innerHTML, /data-person="kimk"><span class="ava">김<\/span>김경율 <span class="me">나<\/span>/);
  assert.match(box.innerHTML, /class="person-chip on" data-person="kimk"/);
  context.pick('');
  assert.equal(context.focus(), '', '[전체] 를 누르면 로그인해 있어도 전체를 본다');
  context.pick('choi');
  assert.equal(context.focus(), 'choi');
  assert.match(scheduleTab, /id="personFilters"/);
});

test('화면에 인라인 이벤트 처리기를 쓰지 않는다 (CSP script-src-attr none)', () => {
  assert.ok(!/\son[a-z]+=/i.test(html.replace(/<script>[\s\S]*?<\/script>/, '')));
});

test('로그인 유형: 승인 담당자는 담당자 이름과 PIN, 근무자는 근무자 이름과 PIN', () => {
  const start = script.indexOf('  function updateLoginRoleFields()');
  const fn = script.slice(start, script.indexOf('\n  }\n', start) + 4);
  const node = () => ({ hidden: false, required: true });
  const nodes = { '#loginRole': { value: 'approver' }, '#loginNameLabel': node(), '#employeeLoginSelect': node(), '#loginApproverLabel': node(), '#loginApproverSelect': node(), '#loginPinHint': node(), '#loginApproverNote': node() };
  const context = vm.createContext({ $: selector => nodes[selector] });
  vm.runInContext(fn + '\nupdateLoginRoleFields();', context);
  assert.equal(nodes['#employeeLoginSelect'].hidden, true);
  assert.equal(nodes['#loginApproverSelect'].hidden, false);
  assert.equal(nodes['#loginApproverNote'].hidden, false);
  assert.equal(nodes['#loginPinHint'].hidden, true);
  nodes['#loginRole'].value = 'employee';
  vm.runInContext('updateLoginRoleFields();', context);
  assert.equal(nodes['#employeeLoginSelect'].hidden, false);
  assert.equal(nodes['#loginApproverSelect'].hidden, true);
  assert.equal(nodes['#loginPinHint'].hidden, false);
  assert.match(html, /<option value="approver">승인 담당자<\/option>/);
  assert.match(html, /처음 로그인할 때 PIN은 0000이에요/);
});
