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
  data.staff.push(data.staff[0]); await assert.rejects(createWorkbook(data),{status:400});
  await assert.rejects(createWorkbook({...payload(),month:13}),{status:400});
  const short = payload(); short.staff[0].shifts.pop(); await assert.rejects(createWorkbook(short),{status:400});
});
test('browser export uses visible month, monthly order, active dates and effective shifts', async () => {
  const html = await fs.readFile(path.join(__dirname,'../index.html'),'utf8');
  const fn = html.slice(html.indexOf('  // 이름으로 판별하므로 앞뒤 공백'),html.indexOf('  async function exportPdf(){'));
  let body; let downloaded; let revoked; const button={disabled:false};
  const context = {
    STATE:{settings:{dayWorkerName:'변경한 일근자'}},
    $:()=>button, getCurrentMonthView:()=>({year:2028,monthIndex:1}),
    getActiveStaff:()=>[{id:'b',name:'B',routine:true},{id:'day',name:'변경한 일근자',routine:false},{id:'tc',name:'교육생',routine:false},{id:'a',name:'A',routine:true}],
    isRoutineWorker:e=>e.routine, isEmployeeActiveOnDate:(e,d)=>e.id!=='b'||d.getDate()>1,
    effectiveShift:(id,d)=>id==='a'&&d.getDate()===2?'휴가':'야', getHolidayInfo:d=>d.getDate()===9?{}:null,
    fetch:async (url,options)=>{assert.equal(url,'/api/export/excel');body=JSON.parse(options.body);return {ok:true,blob:async()=>({})};},
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:u=>revoked=u},
    document:{createElement:()=>({click(){downloaded=this.download;},remove(){}}),body:{appendChild(){}}},
    showToast(){},alert(message){throw Error(message);},console,setTimeout:fn=>fn()
  };
  vm.createContext(context); await vm.runInContext(fn+';exportExcel()',context);
  assert.equal(body.month,2); assert.equal(body.year,2028); assert.equal(body.staff[0].name,'B');
  assert.doesNotMatch(JSON.stringify(body), /변경한 일근자/);
  assert.equal(body.staff.length,2); assert.equal(body.staff[0].shifts.length,29);
  assert.equal(body.staff[0].shifts[0],''); assert.equal(body.staff[1].shifts[1],'휴가');
  assert.equal(body.tcStaff.length,1); assert.equal(body.tcStaff[0].name,'교육생');
  assert.equal(body.tcStaff[0].shifts.length,29); assert.equal(body.tcStaff[0].shifts[0],'야');
  assert.equal(body.holidays[8],true); assert.match(downloaded,/2028년 2월.*xlsx$/);
  assert.equal(button.disabled,false); assert.equal(revoked,'blob:test');
  // 이름으로 찾지 못하면(공백 차이는 무시) 아무도 빼지 않고 경고한다.
  const toasts=[];
  for (const [name, excluded] of [['  변경한   일근자 ',true],['없는 이름',false]]) {
    toasts.length=0; context.STATE.settings.dayWorkerName=name; context.showToast=(m,t)=>toasts.push([m,t]);
    await vm.runInContext('exportExcel()',context);
    assert.equal(/변경한 일근자/.test(JSON.stringify(body)), !excluded);
    assert.equal(toasts[0][1], excluded ? 'ok' : 'warn');
    if (!excluded) assert.match(toasts[0][0], /찾지 못해/);
  }
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
    assert.match(cell(sheet,'AM10'),/&lt;휴가신청절차&gt;/);
    assert.match(cell(sheet,'AM14'),/대일/); assert.match(cell(sheet,'AM15'),/휴가/);
    assert.match(cell(sheet,'AO14'),/대근 해당자가 직접 표기/);
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
