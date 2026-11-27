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

test('PDF 는 화면을 찍지 않고 엑셀 양식과 같은 데이터로 그리며, 파견사원(일근) 줄은 뺀다', () => {
  assert.match(scheduleTab, /<aside class="schedule-rail"[^>]*data-html2canvas-ignore="true"/);
  const start = script.indexOf('  async function exportPdf(){');
  const fn = script.slice(start, script.indexOf('\n  }\n', start));
  assert.match(fn, /buildExcelPayload\(year, monthIndex, \{ includeDayWorkers: false \}\)/);
  assert.match(fn, /buildSheetHtml\(payload\)/);
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
  const nodes = { '#loginRole': { value: 'approver' }, '#loginNameLabel': node(), '#employeeLoginSelect': node(), '#loginApproverLabel': node(), '#loginApproverSelect': node(), '#loginPinHint': node(), '#loginApproverNote': node(), '#loginAdminNote': node() };
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
  // 로그인 목록 순서: 근무자 → 승인 담당자 → 시스템 관리자
  assert.match(html, /<option value="employee">근무자<\/option><option value="approver">승인 담당자<\/option><option value="admin">시스템 관리자<\/option>/);
  assert.match(html, /처음 로그인할 때 PIN은 0000이에요/);
});

test('엑셀 양식 근무표: 묶음은 엑셀 내보내기와 같은 NC/TC 기준, TC 가 없으면 생략, 일근(파견사원)은 TC 아래 PDF 제외 묶음', () => {
  const start = script.indexOf('  function scheduleGroups(');
  const fn = script.slice(start, script.indexOf('\n  }\n', start) + 4);
  const staff = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'edu' }, { id: 'seo' }];
  const context = vm.createContext({
    isDispatchedDayWorker: emp => emp.id === 'seo',
    isRoutineWorker: emp => ['a', 'b', 'c', 'd'].includes(emp.id),
    workTypeOf: emp => emp.id === 'seo' ? 'dispatch' : ['a', 'b', 'c', 'd'].includes(emp.id) ? 'NC' : 'TC'
  });
  vm.runInContext(fn + '\nthis.groups = scheduleGroups;', context);
  const groups = context.groups(staff, 2026, 11);
  assert.deepEqual(JSON.parse(JSON.stringify(groups.map(g => [g.label, g.staff.map(e => e.id).join(','), g.pdfIgnore]))),
    [['NC', 'a,b,c,d', false], ['TC', 'edu', false], ['일근', 'seo', true]]);
  assert.equal(context.groups(staff.slice(0, 4), 2026, 11).map(g => g.label).join(','), 'NC', 'TC 가 없으면 TC 묶음은 없다');
  // 엑셀 내보내기도 같은 기준(근무 형태 workTypeOf)으로 나눈다.
  assert.match(script, /getActiveStaff\(year, monthIndex\)\.forEach\(emp => groups\[workTypeOf\(emp, month\)\]\?\.push\(emp\)\)/);
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

test('일근(파견사원) 기본 근무: 평일 일, 토·일·공휴일 O, NC 4명 자리에 세지 않는다', () => {
  const pick = name => { const s = script.indexOf('  function ' + name + '('); return script.slice(s, script.indexOf('\n  function ', s + 1)); };
  const emps = [{ id: 'lee', name: '이주형' }, { id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' }, { id: 'd', name: 'd' }];
  const context = vm.createContext({
    EMPLOYEES: emps, STATE: { settings: { dayWorkerName: '이주형' }, rotationAnchors: [] }, DEFAULT_DAY_WORKER_NAME: '이주형', WORK_TYPES: ['NC', 'TC', 'dispatch'],
    ROUTINE_HEADCOUNT: 4, CYCLE: ['일', '야', '조', 'O'], dayIndex: () => 0,
    getHolidayInfo: d => d.getDate() === 25 && d.getMonth() === 11 ? { name: '성탄절' } : null,
    getActiveStaff: () => emps, getToday: () => new Date(2026, 11, 1)
  });
  vm.runInContext(['stripTime', 'fmt', 'getRotationAnchorFor', 'baseShift', 'rotationShift', 'isWeekendOrHoliday', 'dispatchedNameKey', 'dayWorkerName', 'isDispatchedDayWorker', 'rotationRoleAt', 'isRoutineWorker', 'workTypeChangesOf', 'activeWorkTypeChange', 'workTypeAt'].map(pick).join('\n'), context);
  const shift = day => context.baseShift('lee', new Date(2026, 11, day));
  assert.equal(shift(1), '일');   // 화
  assert.equal(shift(5), 'O');    // 토
  assert.equal(shift(6), 'O');    // 일
  assert.equal(shift(25), 'O');   // 성탄절(금)
  assert.equal(shift(24), '일');  // 목
  // 순서상 맨 위에 있어도 NC 는 나머지 4명이다.
  assert.equal(context.isRoutineWorker(emps[0]), false);
  assert.equal(emps.slice(1).every(e => context.isRoutineWorker(e)), true);
});

test('TC 상일근은 처음부터 TC 인 사람도 평일 일, 토·일·공휴일 O (교대로 돌지 않는다)', () => {
  const pick = name => { const s = script.indexOf('  function ' + name + '('); return script.slice(s, script.indexOf('\n  function ', s + 1)); };
  const emps = [{ id: 'hwang', name: '황', workType: 'TC', phase: 0 }, { id: 'nc', name: 'nc', workType: 'NC', phase: 0 },
    { id: 'kim', name: 'kim', workType: 'TC', phase: 0, workTypeChanges: [{ from: '2026-12-10', workType: 'NC', at: '1' }] }];
  const context = vm.createContext({
    EMPLOYEES: emps, STATE: { settings: {}, rotationAnchors: [{ id: 'x', empId: 'kim', startDate: '2026-12-10', startShift: '조', at: '1' }] },
    DEFAULT_DAY_WORKER_NAME: '이주형', WORK_TYPES: ['NC', 'TC', 'dispatch'], ROUTINE_HEADCOUNT: 4, CYCLE: ['일', '야', '조', 'O'], dayIndex: d => d.getDate(),
    getHolidayInfo: d => d.getDate() === 25 && d.getMonth() === 11 ? { name: '성탄절' } : null, getActiveStaff: () => emps, getToday: () => new Date(2026, 11, 1)
  });
  vm.runInContext(['stripTime', 'fmt', 'getRotationAnchorFor', 'baseShift', 'rotationShift', 'isWeekendOrHoliday', 'dispatchedNameKey', 'dayWorkerName',
    'isDispatchedDayWorker', 'workTypeChangesOf', 'activeWorkTypeChange', 'workTypeAt'].map(pick).join('\n'), context);
  const shift = (id, day) => context.baseShift(id, new Date(2026, 11, day));
  // 12/1 화 ~ 12/7 월: 평일 일, 토·일 O. 성탄절(12/25 금)도 O.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(d => shift('hwang', d)), ['일', '일', '일', '일', 'O', 'O', '일']);
  assert.equal(shift('hwang', 25), 'O');
  assert.equal(shift('hwang', 24), '일');
  // NC 는 그대로 교대로 돈다.
  assert.notDeepEqual([1, 2, 3, 4].map(d => shift('nc', d)), ['일', '일', '일', '일']);
  // 처음엔 TC 였다가 12/10 부터 NC 가 된 사람: 9일까지는 상일근(12/5 토 O, 12/8 화 일), 10일부터 교대.
  assert.equal(shift('kim', 5), 'O');
  assert.equal(shift('kim', 8), '일');
  assert.deepEqual([10, 11, 12, 13].map(d => shift('kim', d)), ['조', 'O', '일', '야']);
});

test('직원 편집의 [근무 형태]가 이름보다 우선하고, NC 교대근무 위 4명만 자동대근 대상이다', () => {
  const pick = name => { const s = script.indexOf('  function ' + name + '('); return script.slice(s, script.indexOf('\n  function ', s + 1)); };
  const staff = [
    { id: 'a', name: 'a', workType: 'NC' }, { id: 'tc', name: '황', workType: 'TC' }, { id: 'b', name: 'b', workType: 'NC' },
    { id: 'c', name: 'c', workType: 'NC' }, { id: 'd', name: 'd', workType: 'NC' }, { id: 'new', name: '적응', workType: 'NC' },
    { id: 'lee', name: '이주형', workType: 'dispatch' }
  ];
  const context = vm.createContext({
    STATE: { settings: {} }, DEFAULT_DAY_WORKER_NAME: '이주형', WORK_TYPES: ['NC', 'TC', 'dispatch'], ROUTINE_HEADCOUNT: 4,
    getActiveStaff: () => staff, getToday: () => new Date(2026, 11, 1)
  });
  vm.runInContext(['fmt', 'dispatchedNameKey', 'dayWorkerName', 'isDispatchedDayWorker', 'workTypeOf', 'rotationRoleAt', 'isRoutineWorker', 'workTypeChangesOf', 'activeWorkTypeChange', 'workTypeAt'].map(pick).join('\n'), context);
  assert.equal(context.isDispatchedDayWorker({ name: '이주형' }), true);                       // 근무 형태 없는 예전 데이터: 이름으로
  assert.equal(context.isDispatchedDayWorker({ name: '이주형', workType: 'TC' }), false);
  assert.equal(context.isDispatchedDayWorker({ name: '새 사원', workType: 'dispatch' }), true);
  // TC 가 중간에 끼어 있어도 NC 위 4명(a,b,c,d)이 자동대근, 5번째 NC(적응)는 아니다.
  assert.deepEqual(staff.filter(e => context.isRoutineWorker(e)).map(e => e.id).join(','), 'a,b,c,d');
  assert.equal(context.workTypeOf(staff[5]), 'NC');
  assert.equal(context.workTypeOf(staff[1]), 'TC');
  assert.equal(context.workTypeOf(staff[6]), 'dispatch');
});

test('근무 형태 바꾸기: 바꾼 날부터만 형태가 바뀌고, TC 는 평일 일·휴일 O, 자동대근 4명도 그 날부터 바뀐다', () => {
  const pick = name => { const s = script.indexOf('  function ' + name + '('); return script.slice(s, script.indexOf('\n  function ', s + 1)); };
  const staff = [
    { id: 'a', name: 'a', workType: 'NC', phase: 0, workTypeChanges: [{ from: '2026-12-10', workType: 'TC', at: '1' }] },
    { id: 'b', name: 'b', workType: 'NC', phase: 1 }, { id: 'c', name: 'c', workType: 'NC', phase: 2 }, { id: 'd', name: 'd', workType: 'NC', phase: 3 },
    { id: 'kim', name: 'kim', workType: 'TC', phase: 0, workTypeChanges: [{ from: '2026-12-10', workType: 'NC', at: '1' }] }
  ];
  const context = vm.createContext({
    EMPLOYEES: staff, STATE: { settings: {}, rotationAnchors: [{ id: 'x', empId: 'kim', startDate: '2026-12-10', startShift: '조', at: '1' }] },
    DEFAULT_DAY_WORKER_NAME: '이주형', WORK_TYPES: ['NC', 'TC', 'dispatch'], ROUTINE_HEADCOUNT: 4, CYCLE: ['일', '야', '조', 'O'], dayIndex: () => 0,
    getHolidayInfo: () => null, getActiveStaff: () => staff, getToday: () => new Date(2026, 11, 1)
  });
  vm.runInContext(['stripTime', 'fmt', 'getRotationAnchorFor', 'baseShift', 'rotationShift', 'isWeekendOrHoliday', 'dispatchedNameKey', 'dayWorkerName',
    'isDispatchedDayWorker', 'workTypeOf', 'rotationRoleAt', 'isRoutineWorker', 'workTypeChangesOf', 'activeWorkTypeChange', 'workTypeAt'].map(pick).join('\n'), context);
  // 바꾸기 전날까지는 예전 형태, 그 날부터 새 형태. 지난 달은 그대로다.
  assert.equal(context.workTypeAt(staff[0], '2026-12-09'), 'NC');
  assert.equal(context.workTypeAt(staff[0], '2026-12-10'), 'TC');
  assert.equal(context.workTypeOf(staff[0], new Date(2026, 10, 15)), 'NC');
  // 자동대근: 9일은 a,b,c,d / 10일부터 b,c,d,kim
  // 날짜는 vm 안에서 만든다(isRoutineWorker 의 instanceof Date 가 vm 의 Date 를 본다).
  const routine = day => staff.filter(e => context.isRoutineWorker(e, vm.runInContext(`new Date(2026, 11, ${day})`, context))).map(e => e.id).join(',');
  assert.equal(routine(9), 'a,b,c,d');
  assert.equal(routine(10), 'b,c,d,kim');
  // TC 가 된 a: 평일 일, 토·일 O (12/12 토, 12/14 월)
  assert.equal(context.baseShift('a', new Date(2026, 11, 12)), 'O');
  assert.equal(context.baseShift('a', new Date(2026, 11, 14)), '일');
  // NC 가 된 kim 은 시작점(10일 조)부터 교대로 돈다.
  assert.deepEqual([10, 11, 12, 13].map(d => context.baseShift('kim', new Date(2026, 11, d))), ['조', 'O', '일', '야']);
  // 달 중간에 새로 들어오는 사람(새 사람으로 등록)은 시작일 전에는 자동대근에 끼지 않는다.
  staff.push({ id: 'new', name: 'new', workType: 'NC', startDate: '2026-12-21', endDate: null });
  staff[1].workTypeChanges = [{ from: '2026-12-21', workType: 'TC', at: '2' }];
  assert.equal(routine(20), 'b,c,d,kim');
  assert.equal(routine(21), 'c,d,kim,new');
});

test('근무 형태 바꾸기 창: 파견사원은 고를 수 없고, 날짜는 직접 고르며, 대신 들어올 사람 단계가 크게 있다', () => {
  assert.match(script, /const WT_CHOICES = \['NC', 'TC'\];/);
  assert.match(script, /<input type="date" name="from" required min="\$\{today\}"/);
  assert.match(script, /class="wt-step wt-partner-step"/);
  assert.match(script, /data-work-type-change=/);
  // 대신 들어올 사람에 '새 사람'(이름·사내메일)을 바로 등록할 수 있다.
  assert.match(script, /data-partner="__new__"/);
  assert.match(script, /name="newName"/);
  assert.match(script, /새 사람의 이름을 입력해 주세요/);
  assert.ok(!/on[a-z]+="/.test(script.slice(script.indexOf('function openWorkTypeDialog'), script.indexOf('function createEmployeeEditor'))));
});

test('근무 형태 바꾸기와 퇴사·전출일이 겹치지 않는다: 저장된 직원은 바꾸기 창으로만, 끝 날짜는 퇴사·전출일', () => {
  // 고르는 칸(지난 달까지 통째로 바뀜)은 아직 저장 안 된 새 직원에게만 보인다.
  const cell = script.slice(script.indexOf('function workTypeCell(row)'), script.indexOf('let selectedId'));
  assert.ok(cell.indexOf('if (!saved)') >= 0 && cell.indexOf('if (!saved)') < cell.indexOf('<select data-work-type'));
  // 끝 날짜는 '퇴사·전출일'이고 근무 형태 바꾸기 안내가 붙는다.
  assert.ok(!/>근무 끝</.test(script));
  assert.match(script, />퇴사·전출일<input type="date" data-field="endDate"/);
  // 반영 안 한 수정이 있어도 막지 않고 먼저 반영한 뒤 창을 연다.
  assert.match(script, /if \(isDirty\(\) && !apply\(\)\) return;\s*openWorkTypeDialog\(id\);/);
  assert.ok(!/먼저 \[직원 구성 반영\]을 눌러 주세요/.test(script));
  // 대신 들어올 사람 후보는 바꾸는 날에 근무 중인 사람만.
  const dialog = script.slice(script.indexOf('function openWorkTypeDialog'), script.indexOf('function createEmployeeEditor'));
  const candidates = script.slice(script.indexOf('function wtHandoverCandidates'), script.indexOf('function staffEventIds'));
  assert.match(dialog, /wtHandoverCandidates\(primaryId, ui.target, ui.from\)/);
  assert.match(candidates, /isEmployeeActiveOnDate\(e, date\)/);
  // 퇴사·전출일이 있으면 그 날까지만 고를 수 있다.
  assert.match(dialog, /max="\$\{escapeAttribute\(emp\.endDate\)\}"/);
});

test('설정: 왼쪽 메뉴에서 근무표 편집 · 직원 구성을 고르고, 직원 구성은 근무 형태별 목록 + 고른 사람 패널(투입 일정 포함)', () => {
  const nav = html.slice(html.indexOf('id="settingsNav"'), html.indexOf('</nav>', html.indexOf('id="settingsNav"')));
  assert.match(nav, /data-settings-pane="editor" data-edit-view="cells">근무표 편집/);
  assert.match(nav, /data-settings-pane="editor" data-edit-view="staff">직원 구성/);
  assert.match(nav, />직원<\/span>/);
  assert.match(nav, />승인 담당자</);
  assert.ok(!/edit-tabs/.test(html), '편집 창 안 탭은 없앴다');
  const panel = html.slice(html.indexOf('id="scheduleEditPanel"'), html.indexOf('id="editSessionBar"'));
  // 근무표의 월별 선택과 직원 구성의 날짜별 선택은 각각 별도이고 기존 근무표 id는 그대로 있다.
  assert.ok(panel.indexOf('id="scheduleEditYear"') < panel.indexOf('id="scheduleEditorView"'));
  assert.match(panel, /class="edit-month" data-for-view="cells"/);
  assert.match(panel, /class="staff-date-controls" data-for-view="staff"/);
  for (const id of ['scheduleEditTable', 'rangeEditEmp', 'addScheduleRangeBtn', 'employeeEditTableBody', 'staffPanel', 'applyEmployeeEditorBtn',
    'bulkFillEmp', 'addBulkFillBtn', 'anchorEmp', 'applyRotationAnchorBtn', 'endedStaffList', 'deletedStaffTrashList', 'onboardingEditorView']) {
    assert.match(panel, new RegExp(`id="${id}"`), id);
  }
  // 투입 일정은 직원 구성 화면(사람 패널 옆) 안에 있다.
  const staff = panel.slice(panel.indexOf('id="employeeEditorView"'));
  assert.ok(staff.includes('id="onboardingEditorView"'));
  assert.ok(staff.indexOf('id="applyEmployeeEditorBtn"') < staff.indexOf('id="staffEvents"'));
  assert.ok(staff.indexOf('id="staffEvents"') < staff.indexOf('id="endedStaffPanel"'));
  assert.match(script, /<details class="sp-rotation-sub" id="staffRotationTools"><summary>교대 루틴 보정/);
  assert.match(script, /setStandaloneRotationAnchor\(values, \{ staffOnly: true, replace: true \}\)/);
  assert.match(script, /focusRotationMonth\(values.startDate\)/);
  assert.match(script, /rotationAppliedPreview\(values.empId, values.startDate\)/);
  assert.ok(!script.includes('staffRotationActual'), '직원 정보에는 보정 적용 결과 줄을 별도 표시하지 않는다');
  assert.ok(!script.includes('data-staff-rotation-remove'), '직원 정보에는 별도의 보정 해제 버튼을 두지 않는다');
  assert.ok(!script.includes('remove-rotation-anchor'), '다른 시작점 목록에도 별도 해제 버튼을 두지 않는다');
  const manualCorrection = script.slice(script.indexOf('function applyManualRotationAnchor()'), script.indexOf('function isRotationAnchorLinked(anchor)'));
  assert.match(manualCorrection, /applyRotationCorrection\(values\)/);
  assert.match(manualCorrection, /setStandaloneRotationAnchor\(values, \{ staffOnly: true, replace: true \}\)/);
  assert.ok(!html.includes('id="rotationAnchorList"') && !html.includes('id="manualRotationAnchorList"'), '루틴 보정 이력 목록은 표시하지 않는다');
  assert.ok(!script.includes('renderRotationAnchorList'));
  const correctionCell = script.slice(script.indexOf('function rotationCorrectionCell(row)'), script.indexOf('function workTypeCell(row)'));
  assert.ok(!correctionCell.includes('STATE.rotationAnchors'), '직원 정보에도 시작점 이력을 표시하지 않는다');
  // 투입 일정은 고른 직원 패널의 탭(정보 · 투입 일정)으로 들어가고, 처음엔 정보 탭이 보인다.
  assert.match(staff, /data-sp-tab="info"[^>]*>정보</);
  assert.match(staff, /data-sp-tab="onboard"[^>]*>투입 일정</);
  assert.match(staff, /id="onboardingEditorView"[^>]*hidden/);
  assert.match(script, /function showPanelTab\(tab\)/);
  // 직원 추가는 위 머리줄이 아니라 목록의 근무 형태 묶음 맨 아래에서 한다.
  assert.ok(!/id="addEmployeeRowBtn"/.test(panel),'직원 추가 버튼은 목록과 함께 그린다');
  assert.match(script, /class="sl-add" type="button" data-add-type=/);
  // 탭을 바꿀 때 main 안의 section 을 모두 숨기므로, 설정 탭 안에는 section 이 없어야 한다.
  const settings = html.slice(html.indexOf('<section id="tab-settings"'), html.indexOf('</section>', html.indexOf('<section id="tab-settings"')) + 10);
  assert.equal((settings.match(/<section/g) || []).length, 1, '설정 탭 안에 section 이 있으면 탭을 바꿀 때 숨는다');
  assert.match(html, /\.schedule-edit-panel\[data-view="cells"\] #employeeEditorView/);
  assert.match(script, /function setEditView\(view\)/);
  assert.match(script, /function openEditorIfClosed\(\)/);
  // 바꾼 칸 표시와 근무 색
  assert.match(script, /classList\.toggle\('is-edited'/);
  assert.match(script, /function editToneClass\(value\)/);
});
