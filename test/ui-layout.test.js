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

test('엑셀 양식 근무표: 묶음은 엑셀 내보내기와 같은 NC/TC 기준, TC 가 없으면 생략, 파견사원은 PDF 제외 묶음', () => {
  const start = script.indexOf('  function scheduleGroups(');
  const fn = script.slice(start, script.indexOf('\n  }\n', start) + 4);
  const staff = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'edu' }, { id: 'seo' }];
  const context = vm.createContext({
    isDispatchedDayWorker: emp => emp.id === 'seo',
    isRoutineWorker: emp => ['a', 'b', 'c', 'd'].includes(emp.id)
  });
  vm.runInContext(fn + '\nthis.groups = scheduleGroups;', context);
  const groups = context.groups(staff, 2026, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => [g.label, g.staff.map(e => e.id).join(','), g.pdfIgnore]))),
    [['NC', 'a,b,c,d', false], ['TC', 'edu', false], ['파견', 'seo', true]]);
  assert.equal(context.groups(staff.slice(0, 4), 2026, 11).map(g => g.label).join(','), 'NC', 'TC 가 없으면 TC 묶음은 없다');
  // 엑셀 내보내기도 같은 함수(isRoutineWorker·isDispatchedDayWorker)로 나눈다.
  assert.match(script, /const tcStaff = exportableStaff\.filter\(emp => !isRoutineWorker\(emp, month\)\)/);
});

test('엑셀 양식 근무표: 머리줄 두 줄, 오늘 강조 없음, 비고는 표에 붙은 칸 + 근무 시간 줄', () => {
  const start = script.indexOf('  function renderScheduleTab(');
  const fn = script.slice(start, script.indexOf('\n  }\n', start));
  assert.match(fn, /<tr class="row-date"><th class="corner xl-sticky" colspan="2" rowspan="2">구분<\/th>/);
  assert.match(fn, /<tr class="row-week">/);
  assert.match(fn, /info \? shortHolidayName\(info\.name\) : WEEKDAY_KO/, '요일 줄에 휴일이면 (줄인) 휴일 이름');
  assert.ok(!/is-today|'오늘'/.test(fn), '오늘 강조는 넣지 않는다');
  assert.match(fn, /data-request-date=/, '내 칸 눌러 신청하기는 그대로');
  assert.match(fn, /getScheduleRange/);
  assert.match(fn, /cell-protected/);
  assert.match(fn, /data-html2canvas-ignore/);
  const sheet = scheduleTab.match(/<div class="xl-sheet">([\s\S]*?)<div class="legend">/)[1];
  assert.ok(sheet.indexOf('id="scheduleTable"') < sheet.indexOf('id="scheduleNotesInput"'));
  assert.match(sheet, /\[일: 09:00 ~ 18:30 , 야: 18:00 ~ 00:00 , 조: 00:00 ~ 09:00 , O: 비번\]/);
  assert.match(sheet, /id="editNotesBtn"/);
  assert.match(sheet, /id="applyNotesBtn"/);
});

test('결재란은 엑셀처럼 두 칸: 예전 데이터에 3칸이 있어도 앞 2칸만 그리고 데이터는 남긴다', () => {
  const pick = name => { const s = script.indexOf('  function ' + name + '('); return script.slice(s, script.indexOf('\n  }\n', s) + 4); };
  const block = {};
  const lines = [{ title: '담당', name: '' }, { title: '팀장', name: '' }, { title: '결재', name: '부장' }];
  const context = vm.createContext({
    $: selector => (selector === '#approvalBlock' ? block : null),
    STATE: { settings: { approvalLines: lines }, monthlyApprovals: { '2026-12': { stale: true } } },
    getCurrentMonthView: () => ({ year: 2026, monthIndex: 11 }),
    monthKeyOf: () => '2026-12',
    currentMonthlyStamp: () => null,
    escapeAttribute: value => String(value)
  });
  vm.runInContext(['getDefaultApprovalLines', 'normalizeApprovalLines', 'getApprovalLines', 'renderApprovalBlock'].map(pick).join('\n') + '\nrenderApprovalBlock();', context);
  assert.equal(block.innerHTML.match(/class="approval-cell"/g).length, 2);
  assert.ok(!block.innerHTML.includes('결재'), '세 번째 칸은 화면에 없다');
  assert.match(block.innerHTML, /재확정 필요/);
  assert.equal(lines.length, 3, '저장된 3칸 데이터는 지우지 않는다');
  assert.ok(!/\{ title: '결재', name: '' \}/.test(script), '새 기본값은 담당 · 팀장 두 칸');
});

test('요일 줄의 긴 휴일 이름은 줄여 쓴다 (기본 목록·휴일 API 이름 모두)', () => {
  const start = script.indexOf('  const HOLIDAY_SHORT_NAMES');
  const fn = script.slice(start, script.indexOf('\n  }\n', start) + 4);
  const context = vm.createContext({});
  vm.runInContext(fn + '\nthis.short = shortHolidayName;', context);
  assert.equal(context.short('기독탄신일'), '성탄절');
  assert.equal(context.short('부처님 오신 날'), '석탄일');
  assert.equal(context.short('어린이날 대체공휴일'), '대체휴일');
  assert.equal(context.short('제22대 국회의원 선거일'), '선거일');
  assert.equal(context.short('설날'), '설날');
  assert.match(script, /title="\$\{escapeAttribute\(info \? info\.name : label\)\}"/, '원래 이름은 마우스를 올리면 보인다');
});

test('표 위 안내: 근무자로 로그인해 누를 칸이 있을 때만 강조 안내, 닫으면 다시 안 뜬다', () => {
  const start = script.indexOf('  const SHEET_HINT_KEY');
  const fn = script.slice(start, script.indexOf('\n  }\n', script.indexOf('function renderSheetHint')) + 4);
  const classes = new Set();
  const nodes = { '#sheetHint': { hidden: false, classList: { toggle: (c, on) => on ? classes.add(c) : classes.delete(c) } }, '#sheetHintText': {}, '#sheetHintClose': { hidden: true } };
  const store = {};
  const context = vm.createContext({ $: s => nodes[s], employeeToken: '', employeeUntil: 0, localStorage: { getItem: k => store[k] ?? null } });
  vm.runInContext(fn + '\nthis.render = renderSheetHint;', context);
  context.render(0);
  assert.match(nodes['#sheetHintText'].textContent, /로그인하면/);
  assert.equal(classes.has('is-tip'), false);
  vm.runInContext('employeeToken = "t"; employeeUntil = Date.now() + 60000;', context);
  context.render(5);
  assert.equal(classes.has('is-tip'), true);
  assert.equal(nodes['#sheetHintClose'].hidden, false);
  store.ncq_hint_request_closed = '1';
  context.render(5);
  assert.equal(nodes['#sheetHint'].hidden, true);
  assert.match(script, /\$\('#sheetHintClose'\)\?\.addEventListener\('click'/);
});
