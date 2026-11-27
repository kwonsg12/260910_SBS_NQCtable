const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const JSZip = require('jszip');
const {createWorkbook} = require('../excel-export');

function payload(year = 2026, month = 10) {
  const days = new Date(year, month, 0).getDate();
  return {year, month, holidays:Array(days).fill(false), staff:['최도인','양명국','김경율','김건호'].map((name,i) =>
    ({name, shifts:Array.from({length:days},(_,d) => ['일','야','조','O'][(d+i)%4])}))};
}
async function contents(data) {
  const zip = await JSZip.loadAsync(await createWorkbook(data));
  const strings = [...(await zip.file('xl/sharedStrings.xml').async('string')).matchAll(/<si><t[^>]*>([\s\S]*?)<\/t><\/si>/g)].map(m=>m[1]);
  const sheet = (await zip.file('xl/worksheets/sheet1.xml').async('string')).replace(/(<c[^>]*t="s"[^>]*>)<v>(\d+)<\/v>/g,(_,start,id)=>`${start}<v>${strings[Number(id)]}</v>`);
  return {zip, sheet};
}
function cell(sheet, address) {
  return sheet.match(new RegExp(`<c r="${address}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`))?.[0];
}
test('NC four, no TC or day-worker output, and actual overrides', async () => {
  const data = payload(); data.staff[0].shifts[0] = '휴가'; data.staff[1].shifts[1] = '대일'; data.holidays[8] = true;
  const {sheet} = await contents(data);
  assert.match(cell(sheet,'D13'),/최도인/); assert.match(cell(sheet,'D16'),/김건호/);
  assert.match(cell(sheet,'E13'),/휴가/); assert.match(cell(sheet,'F14'),/대일/);
  assert.doesNotMatch(sheet,/>TC</);
  assert.match(sheet, /<row\b[^>]*\br="17"[^>]* hidden="1">/);
  for (const column of ['C', 'D', 'E', 'G', 'M']) assert.match(cell(sheet, column + '17'), /\/>$/);
  assert.doesNotMatch(sheet, /서예찬/);
  assert.match(cell(sheet,'AI10'),/<v>31<\/v>/);
});
for (const [year, month, days, firstBlank] of [[2026,2,28,'AG'],[2028,2,29,'AH'],[2026,4,30,'AI']]) {
  test(`${year}-${month} has ${days} days and no leftover dates or shifts`, async () => {
    const {sheet} = await contents(payload(year,month));
    for (const row of [10,12,13,14,15,16,17,18]) assert.match(cell(sheet,`${firstBlank}${row}`),/\/>$/);
    assert.match(cell(sheet,'C10'),new RegExp(`${year}년 ${month}월`));
  });
}
test('source private data/formulas are absent and print layout preserved', async () => {
  const {zip,sheet} = await contents(payload());
  const template = await JSZip.loadAsync(await fs.readFile(path.join(__dirname,'../templates/schedule.xlsx')));
  const source = await template.file('xl/worksheets/sheet1.xml').async('string');
  for (const tag of ['cols','pageMargins','pageSetup']) {
    const pattern = new RegExp(`<${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</${tag}>)`);
    assert.equal(sheet.match(pattern)?.[0], source.match(pattern)?.[0]);
  }
  assert.equal(zip.file('xl/calcChain.xml'),null);
  assert.match(sheet,/<mergeCell ref="C18:AI18"/);
  assert.match(sheet,/<mergeCell ref="C13:C16"/);
  assert.match(cell(sheet,'C21'),/09:00/);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  assert.match(workbook,/!\$C\$2:\$AJ\$21/);
  const rows = [...sheet.matchAll(/<row\b[^>]*\br="(\d+)"/g)].map(m=>m[1]);
  assert.equal(new Set(rows).size,rows.length);
  for (const file of Object.values(zip.files).filter(f => /\.xml$/.test(f.name))) {
    const text = await file.async('string');
    assert.doesNotMatch(text,/#REF!|정재승|최 정 문|하 태 운|11\/25|<f[ >]/);
  }
});
test('XML special characters are text and no extra workers silently disappear', async () => {
  const data = payload(); data.staff[0].name='=A1 & <직원>'; data.staff[0].shifts[0]='=1+1';
  const {sheet} = await contents(data);
  assert.match(cell(sheet,'D13'),/=A1 &amp; &lt;직원&gt;/);
  assert.match(cell(sheet,'E13'),/t="s"/);
  // NC 는 적응 인원까지 5명 이상도 들어간다(줄을 늘린다). 지나치게 많으면 거절한다.
  while (data.staff.length < 21) data.staff.push(data.staff[0]);
  await assert.rejects(createWorkbook(data),{status:400});
  await assert.rejects(createWorkbook({...payload(),month:13}),{status:400});
  const short = payload(); short.staff[0].shifts.pop(); await assert.rejects(createWorkbook(short),{status:400});
});
test('browser export uses visible month, work types, active dates, colors, merged ranges and approval names', async () => {
  const html = await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  const pick = name => { const s = html.indexOf('  function ' + name + '('); return html.slice(s, html.indexOf('\n  function ', s + 1)); };
  const fn = ['shiftKind', 'buildExcelPayload'].map(pick).join('\n')
    + html.slice(html.indexOf('  async function exportExcel(){'), html.indexOf('  async function mailMySchedule(){'));
  let body; let downloaded; let revoked; const button={disabled:false};
  const types = {b:'NC', a:'NC', tc:'TC', day:'dispatch'};
  const range = {empId:'a', startDate:'2028-02-10', endDate:'2028-02-12', value:'경조휴가'};
  const context = {
    $:()=>button, getCurrentMonthView:()=>({year:2028,monthIndex:1}),
    getActiveStaff:()=>[{id:'b',name:'B'},{id:'day',name:'이주형'},{id:'tc',name:'교육생'},{id:'a',name:'A'}],
    workTypeOf:e=>types[e.id], isEmployeeActiveOnDate:(e,d)=>e.id!=='b'||d.getDate()>1,
    effectiveShift:(id,d)=>id==='a'&&d.getDate()===2?'휴가':id==='a'&&d.getDate()>=10&&d.getDate()<=12?'경조휴가':id==='tc'&&d.getDate()===3?'대일':'야',
    isSubstituteShift:(id,d)=>id==='b'&&d.getDate()===5, isStandardShift:v=>['일','야','조','O','휴가','대일','대근'].includes(v),
    getScheduleRange:(id,d)=>id==='a'&&d.getDate()>=10&&d.getDate()<=12?range:undefined,
    getHolidayInfo:d=>d.getDate()===9?{}:null, getApprovalLines:()=>[{title:'담당',name:'홍창훈'},{title:'팀장',name:'최정문'}],
    fetch:async (url,options)=>{assert.equal(url,'/api/export/excel');body=JSON.parse(options.body);return {ok:true,blob:async()=>({})};},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:u=>revoked=u},
    document:{createElement:()=>({click(){downloaded=this.download;},remove(){}}),body:{appendChild(){}}},
    showToast(){},alert(message){throw Error(message);},console,setTimeout:fn=>fn()
  };
  vm.createContext(context); await vm.runInContext(fn+';exportExcel()',context);
  assert.equal(body.month,2); assert.equal(body.year,2028);
  // 묶음은 근무 형태로: NC(B, A) · TC(교육생) · 일근(이주형)
  assert.deepEqual(body.staff.map(p=>p.name),['B','A']);
  assert.deepEqual(body.tcStaff.map(p=>p.name),['교육생']);
  assert.deepEqual(body.dayStaff.map(p=>p.name),['이주형']);
  assert.equal(body.staff[0].shifts.length,29); assert.equal(body.staff[0].shifts[0],'');
  // 색: 휴가 leave · 대일 sub · 대근(야/조) sub · 경조휴가 custom
  assert.equal(body.staff[1].shifts[1],'휴가'); assert.equal(body.staff[1].kinds[1],'leave');
  assert.equal(body.tcStaff[0].kinds[2],'sub'); assert.equal(body.staff[0].kinds[4],'sub');
  assert.equal(body.staff[0].kinds[5],''); assert.equal(body.staff[1].kinds[9],'custom');
  // 병합 기간은 한 덩어리로
  assert.deepEqual(body.staff[1].spans,[{start:10,end:12,label:'경조휴가',kind:'custom'}]);
  assert.deepEqual(body.approvalNames,['홍창훈','최정문']);
  assert.equal(body.holidays[8],true); assert.match(downloaded,/2028년 2월.*xlsx$/);
  assert.equal(button.disabled,false); assert.equal(revoked,'blob:test');
  // PDF 용(파견사원 제외)
  const pdf = vm.runInContext('buildExcelPayload(2028, 1, { includeDayWorkers: false })', context);
  assert.equal(pdf.payload.dayStaff.length,0); assert.equal(pdf.excluded,1);
});

test('엑셀: 색 칠하기, 병합 칸, 일근 줄, 결재 이름, NC 5명 이상', async () => {
  const data = payload(2026, 11);
  data.staff.push({name:'적응', shifts:Array(30).fill('일')});
  data.staff[0].shifts[0] = '휴가';
  data.staff[1].kinds = Array(30).fill(''); data.staff[1].kinds[1] = 'sub';
  data.staff[2].shifts.fill('경조휴가', 9, 12);
  data.staff[2].spans = [{start:10, end:12, label:'경조휴가', kind:'custom'}];
  data.tcStaff = [{name:'황돈희', shifts:Array(30).fill('일')}];
  data.dayStaff = [{name:'이주형', shifts:Array(30).fill('일')}];
  data.approvalNames = ['홍창훈', '최정문'];
  const {sheet, zip} = await contents(data);
  const styles = await zip.file('xl/styles.xml').async('string');
  const xfs = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/)[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const fills = styles.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/)[1].match(/<fill>[\s\S]*?<\/fill>/g);
  const fillOf = address => fills[Number(/fillId="(\d+)"/.exec(xfs[Number(/ s="(\d+)"/.exec(cell(sheet, address))[1])])[1])];
  // NC 5명: 13~17, TC 18, 일근 19
  assert.match(cell(sheet,'D17'),/적응/); assert.match(cell(sheet,'C13'),/NC/);
  assert.match(sheet,/<mergeCell ref="C13:C17"\/>/);
  assert.match(cell(sheet,'C18'),/>TC</); assert.match(cell(sheet,'D18'),/황돈희/);
  assert.match(cell(sheet,'C19'),/일근/); assert.match(cell(sheet,'D19'),/이주형/);
  assert.doesNotMatch(sheet, /<row\b[^>]*\br="19"[^>]* hidden="1">/);
  assert.match(fillOf('E13'), /FFFFFF00/);          // 휴가 노랑
  assert.match(fillOf('F14'), /FF92D050/);          // 대근 초록
  assert.match(fillOf('N15'), /FFD9D9D9/);          // 경조휴가 회색
  assert.match(cell(sheet,'N15'),/경조휴가/); assert.match(cell(sheet,'O15'),/\/>$/); assert.match(cell(sheet,'P15'),/\/>$/);
  assert.match(sheet,/<mergeCell ref="N15:P15"\/>/);
  assert.match(cell(sheet,'AA6'),/홍창훈/); assert.match(cell(sheet,'AE6'),/최정문/);
  assert.match(cell(sheet,'C23'),/09:00/);
  const workbook = await zip.file('xl/workbook.xml').async('string');
  assert.ok(workbook.includes('!$C$2:$AJ$23'));
  const count = Number(/<mergeCells count="(\d+)"/.exec(sheet)[1]);
  assert.equal(count, (sheet.match(/<mergeCell ref=/g) || []).length);
  // 겹치는 병합은 거절
  data.staff[2].spans.push({start:12, end:13, label:'x'});
  await assert.rejects(createWorkbook(data), {status:400});
});

for (const count of [0,1,3]) {
  test(`TC ${count} workers: names, shifts, legend, row references and print area`, async () => {
    const data = payload(2028,2);
    data.tcStaff = Array.from({length:count},(_,i)=>({name:`교육생${i+1}`,shifts:Array(29).fill('일')}));
    if (count) { data.tcStaff[0].shifts[0]=''; data.tcStaff[0].shifts[1]='휴가'; }
    const {sheet,zip} = await contents(data);
    for (let i=0;i<count;i++) {
      assert.match(cell(sheet,`C${17+i}`),/>TC</);
      assert.match(cell(sheet,`D${17+i}`),new RegExp(`교육생${i+1}`));
      assert.match(cell(sheet,`AG${17+i}`),/>일</);
      assert.match(cell(sheet,`AH${17+i}`),/\/>$/);
    }
    if(count) { assert.match(cell(sheet,'E17'),/\/>$/); assert.match(cell(sheet,'F17'),/휴가/); }
    assert.match(cell(sheet,`D${17+count}`),/\/>$/);
    assert.match(cell(sheet,`C${21+count}`),/09:00/);
    // 예전 <휴가신청절차> 안내(AK 열부터)는 없앴다.
    assert.doesNotMatch(sheet,/휴가신청절차|대근 해당자가 직접 표기/);
    assert.doesNotMatch(sheet,/<c r="A[K-P]\d+"/);
    const refs=[...sheet.matchAll(/<c r="([A-Z]+\d+)"/g)].map(m=>m[1]);
    assert.equal(new Set(refs).size,refs.length);
    for (const row of sheet.matchAll(/<row\b[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
      for(const c of row[2].matchAll(/<c r="[A-Z]+(\d+)"/g)) assert.equal(c[1],row[1]);
    }
    const workbook=await zip.file('xl/workbook.xml').async('string');
    assert.ok(workbook.includes(`!$C$2:$AJ$${21+count}`));
    assert.match(sheet,new RegExp(`<mergeCell ref="C${18+count}:AI${18+count}"`));
  });
}
test('invalid TC payload is rejected', async () => {
  await assert.rejects(createWorkbook({...payload(),tcStaff:{}}),{status:400});
  await assert.rejects(createWorkbook({...payload(),tcStaff:[{name:'교육생',shifts:[]}]}),{status:400});
});

test('legacy day worker name and shifts are not exported with or without TC', async () => {
  for (const count of [0,2]) {
    const data={...payload(),dayWorkerName:'  김일근 & 교육  ',tcStaff:Array.from({length:count},()=>({name:'교육생',shifts:Array(31).fill('일')}))};
    const {sheet}=await contents(data);
    assert.match(cell(sheet,`D${17+count}`),/\/>$/);
    assert.doesNotMatch(sheet,/김일근/);
    assert.doesNotMatch(sheet,/서예찬/);
    assert.match(cell(sheet,`E${17+count}`),/\/>$/);
  }
  const {sheet}=await contents({...payload(),dayWorkerName:'   '});
  assert.match(cell(sheet,'D17'),/\/>$/);
  await assert.rejects(createWorkbook({...payload(),dayWorkerName:123}),{status:400});
  await assert.rejects(createWorkbook({...payload(),dayWorkerName:'가'.repeat(51)}),{status:400});
});

test('day worker setting saves, reloads, renders and defaults for existing data', async () => {
  const html=await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end));
  const code=extract('  function normalizeState(raw = {}){','  function getOrderedEmployeeIds(')
    +extract('  function renderSettings(){','  function applyApprovalLines(){')
    +extract('  function saveSettings(){','  function saveQuota(){');
  const fields=new Map(); let saved;
  const context={STATE:{settings:{},auditLogs:[]},EMPLOYEES:[],DEFAULT_STATION_NAME:'통합관제실',DEFAULT_DAY_WORKER_NAME:'이주형',
    dayWorkerName:()=>{const n=String(context.STATE.settings.dayWorkerName||'').trim();return !n||n==='서예찬'?'이주형':n;},BASE_LOCK_DAY:25,STORE_KEY:'test',
    $:id=>{if(!fields.has(id))fields.set(id,{value:''});return fields.get(id);},
    requireAdmin:()=>true,loadState:()=>context.normalizeState(saved),
    saveState:()=>{saved=JSON.parse(JSON.stringify(context.STATE));},
    getApprovalLines:()=>[],renderAll(){},updateLiveClock(){},showToast(){}};
  vm.createContext(context);vm.runInContext(code,context);
  vm.runInContext('STATE=loadState();renderSettings()',context);
  assert.equal(fields.get('#dayWorkerName').value,'이주형');
  fields.get('#dayWorkerName').value='  변경 이름  ';
  vm.runInContext('saveSettings();STATE=loadState();renderSettings()',context);
  assert.equal(saved.settings.dayWorkerName,'변경 이름');
  assert.equal(fields.get('#dayWorkerName').value,'변경 이름');
  fields.get('#dayWorkerName').value='  ';
  vm.runInContext('saveSettings();STATE=loadState();renderSettings()',context);
  assert.equal(fields.get('#dayWorkerName').value,'이주형');
});

test('예전 기본값(서예찬)으로 저장된 일근 이름은 저장값은 그대로 두고 이주형으로 읽는다', async()=>{
  const html=await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  const pick=name=>{const s=html.indexOf('  function '+name+'(');return html.slice(s,html.indexOf('\n  function ',s+1));};
  const context={STATE:{settings:{dayWorkerName:'서예찬'}},DEFAULT_DAY_WORKER_NAME:'이주형'};
  vm.createContext(context);vm.runInContext(pick('dispatchedNameKey')+'\n'+pick('dayWorkerName'),context);
  assert.equal(context.dayWorkerName(),'이주형');
  context.STATE.settings.dayWorkerName='  다른   사원 ';
  assert.equal(context.dayWorkerName(),'다른 사원');
  // 불러올 때 저장값을 바꾸지 않는다(바꾸면 근무자 저장이 '설정 변경'으로 거절된다).
  const code=html.slice(html.indexOf('  function normalizeState(raw = {}){'),html.indexOf('  function getOrderedEmployeeIds('));
  const n={EMPLOYEES:[],DEFAULT_STATION_NAME:'통합관제실',DEFAULT_DAY_WORKER_NAME:'이주형',BASE_LOCK_DAY:25};
  vm.createContext(n);vm.runInContext(code,n);
  assert.equal(n.normalizeState({settings:{dayWorkerName:'서예찬'}}).settings.dayWorkerName,'서예찬');
});
