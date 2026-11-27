'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const TEMPLATE = path.join(__dirname, 'templates', 'schedule.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const LEGEND = '[일: 09:00 ~ 18:30 ,   야: 18:00 ~ 00:00 ,  조: 00:00 ~ 09:00 ,   O:비번]';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
// 칸 색: 휴가 노랑 · 대일/대근 초록 · 경조휴가 같은 수동 입력 회색(양식 styles.xml 의 fill 번호, 회색은 새로 붙인다)
const KINDS = ['', 'leave', 'sub', 'custom'];
const FILL = { white: 2, leave: 3, sub: 5, weekend: 6 };
const GRAY_FILL = '<fill><patternFill patternType="solid"><fgColor rgb="FFD9D9D9"/><bgColor indexed="64"/></patternFill></fill>';
// 양식의 묶음 줄: NC 13~16(4줄), TC 17, 일근(파견사원) 18. 19~21 비고, 22 근무시간 안내.
const NC_FIRST = 13, NC_TEMPLATE_ROWS = 4, TC_ROW = 17, DAY_ROW = 18;
const MAX_ROWS = { staff: 20, tcStaff: 100, dayStaff: 5 };
const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function column(n) {
  let result = '';
  while (n) { result = String.fromCharCode(65 + (n - 1) % 26) + result; n = Math.floor((n - 1) / 26); }
  return result;
}
function columnNumber(letters) {
  return [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
}
// kinds 를 보내지 않은 예전 데이터(월 확정본 백업 등)는 글자로 색을 정한다.
function kindOf(value) {
  if (value === '휴가') return 'leave';
  if (value === '대일' || value === '대근') return 'sub';
  return value && !['일', '야', '조', 'O'].includes(value) ? 'custom' : '';
}

function validate(data) {
  const fail = () => { const e = new Error('엑셀 출력 데이터가 올바르지 않습니다.'); e.status = 400; throw e; };
  if (!data || !Number.isInteger(data.year) || data.year < 1900 || data.year > 9999 ||
      !Number.isInteger(data.month) || data.month < 1 || data.month > 12) fail();
  const days = new Date(Date.UTC(data.year, data.month, 0)).getUTCDate();
  if (data.dayWorkerName !== undefined && (typeof data.dayWorkerName !== 'string' || data.dayWorkerName.length > 50)) fail();
  if (!Array.isArray(data.staff) || data.staff.length > MAX_ROWS.staff) fail();
  for (const key of ['tcStaff', 'dayStaff']) {
    if (data[key] !== undefined && (!Array.isArray(data[key]) || data[key].length > MAX_ROWS[key])) fail();
  }
  for (const person of [...data.staff, ...(data.tcStaff || []), ...(data.dayStaff || [])]) {
    if (!person || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 50 ||
        !Array.isArray(person.shifts) || person.shifts.length !== days ||
        person.shifts.some(v => typeof v !== 'string' || v.length > 20)) fail();
    if (person.kinds !== undefined && (!Array.isArray(person.kinds) || person.kinds.length !== days ||
        person.kinds.some(v => !KINDS.includes(v)))) fail();
    if (person.spans !== undefined) {
      if (!Array.isArray(person.spans) || person.spans.length > days) fail();
      let lastEnd = 0;
      for (const span of [...person.spans].sort((a, b) => (a?.start || 0) - (b?.start || 0))) {
        if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 1 ||
            span.end > days || span.start > span.end || span.start <= lastEnd ||
            typeof span.label !== 'string' || span.label.length > 20 ||
            (span.kind !== undefined && !KINDS.includes(span.kind))) fail();
        lastEnd = span.end;
      }
    }
  }
  if (!Array.isArray(data.holidays) || data.holidays.length !== days || data.holidays.some(v => typeof v !== 'boolean')) fail();
  if (data.approvalNames !== undefined && (!Array.isArray(data.approvalNames) || data.approvalNames.length > 2 ||
      data.approvalNames.some(v => typeof v !== 'string' || v.length > 30))) fail();
  return days;
}

// 양식의 row 번째 줄을 count 줄로 바꾼다(0이면 지운다). 아래 줄과 병합·인쇄 영역 주소는 그만큼 밀린다.
function expandRow(sheet, row, count) {
  const delta = count - 1;
  const shift = text => text.replace(/(\$?[A-Z]+\$?)(\d+)/g, (_, col, r) => col + (Number(r) > row ? Number(r) + delta : r));
  const original = sheet.match(new RegExp(`<row\\b[^>]*\\br="${row}"[^>]*>[\\s\\S]*?</row>`))[0];
  if (delta) {
    sheet = sheet.replace(/\br="([A-Z]*)(\d+)"/g, (_, col, r) => `r="${col}${Number(r) > row ? Number(r) + delta : r}"`)
      .replace(/\b(ref|sqref|activeCell|topLeftCell)="([^"]*)"/g, (_, key, value) => `${key}="${shift(value)}"`);
  }
  const copies = Array.from({length: count}, (_, i) => original.replace(new RegExp(`\\br="([A-Z]*)${row}"`, 'g'), (_, col) => `r="${col}${row + i}"`));
  return { sheet: sheet.replace(original, () => copies.join('')), shift };
}

// Only the checked-in, fixed template is processed here; uploaded workbooks are never accepted.
// Replace cell contents while keeping widths, heights, merges, borders and printer settings intact.
// layout 이 있으면 묶음 줄 수를 맞추고, 오른쪽의 예전 <휴가신청절차> 안내(AK 열부터)를 지우고, 병합 칸을 더한다.
async function fillTemplate(bytes, cells, grid = new Map(), layout = null) {
  const zip = await JSZip.loadAsync(bytes);
  let styles = await zip.file('xl/styles.xml').async('string');
  const styleBlock = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  const xfs = styleBlock[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const fillBlock = styles.match(/<fills\b[^>]*>([\s\S]*?)<\/fills>/);
  const fillCount = (fillBlock[1].match(/<fill\b/g) || []).length;
  const fills = { ...FILL, custom: fillCount };
  const cache = new Map();
  const strings = [];
  const stringIds = new Map();
  let stringCount = 0;
  let sheet = await zip.file(SHEET).async('string');
  const shifts = [];
  if (layout) {
    // 아래 줄부터 늘린다: 일근 → TC → NC(마지막 줄을 복제해 4줄 넘게).
    let result = expandRow(sheet, DAY_ROW, layout.dayRows); sheet = result.sheet; shifts.push(result.shift);
    result = expandRow(sheet, TC_ROW, layout.tcRows); sheet = result.sheet; shifts.push(result.shift);
    const ncLast = NC_FIRST + NC_TEMPLATE_ROWS - 1;
    const ncCopies = layout.ncRows - (NC_TEMPLATE_ROWS - 1);
    result = expandRow(sheet, ncLast, ncCopies); sheet = result.sheet; shifts.push(result.shift);
    sheet = sheet.replace(`<mergeCell ref="C${NC_FIRST}:C${ncLast}"/>`, `<mergeCell ref="C${NC_FIRST}:C${NC_FIRST + layout.ncRows - 1}"/>`);
    if (layout.hideDayRow) {
      sheet = sheet.replace(new RegExp(`<row\\b[^>]*\\br="${layout.dayFirst}"[^>]*>`), row =>
        row.replace(/\s+hidden="[^"]*"/, '').replace(/>$/, ' hidden="1">'));
    }
    // 예전 <휴가신청절차> 안내(인쇄 영역 밖 AK 열부터)는 더 쓰지 않는다.
    sheet = sheet.replace(/<mergeCell ref="A[K-Z]\d+:[A-Z]+\d+"\/>/g, '');
    const merges = layout.merges || [];
    sheet = sheet.replace(/<mergeCells\b[^>]*>([\s\S]*?)<\/mergeCells>/, (_, body) => {
      const all = body + merges.map(ref => `<mergeCell ref="${ref}"/>`).join('');
      return `<mergeCells count="${(all.match(/<mergeCell\b/g) || []).length}">${all}</mergeCells>`;
    });
  }
  const seen = new Set();
  sheet = sheet.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (whole, attrs) => {
    const address = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!address) throw new Error('엑셀 양식의 셀 주소를 읽을 수 없습니다.');
    if (layout && columnNumber(address.match(/^[A-Z]+/)[0]) >= columnNumber('AK')) return '';
    seen.add(address);
    let style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] || 0);
    const format = grid.get(address);
    if (format) {
      const original = xfs[style];
      const border = /\bborderId="(\d+)"/.exec(original)?.[1] || '0';
      const fill = fills[format.fill];
      const key = `${format.header}:${fill}:${border}`;
      if (!cache.has(key)) {
        const base = xfs[format.header ? 62 : 64].replace(/\bborderId="\d+"/, `borderId="${border}"`)
          .replace(/\bfillId="\d+"/, `fillId="${fill}"`);
        cache.set(key, xfs.length); xfs.push(base);
      }
      style = cache.get(key);
    }
    const value = cells.get(address);
    // Explicit strings prevent names or shift labels beginning with '=' from becoming formulas.
    if (value === undefined || value === '') return `<c r="${address}" s="${style}"/>`;
    if (typeof value === 'number') return `<c r="${address}" s="${style}"><v>${value}</v></c>`;
    if (!stringIds.has(value)) { stringIds.set(value, strings.length); strings.push(value); }
    stringCount++;
    return `<c r="${address}" s="${style}" t="s"><v>${stringIds.get(value)}</v></c>`;
  });
  for (const address of cells.keys()) if (!seen.has(address)) throw new Error(`엑셀 양식에 ${address} 셀이 없습니다.`);
  styles = styles.replace(styleBlock[0], `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`);
  if (layout) styles = styles.replace(fillBlock[0], `<fills count="${fillCount + 1}">${fillBlock[1]}${GRAY_FILL}</fills>`);
  zip.file(SHEET, sheet);
  zip.file('xl/styles.xml', styles);
  // Rebuild the string table: no source names or notes survive in unused shared strings.
  zip.file('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${stringCount}" uniqueCount="${strings.length}">${strings.map(value => `<si><t xml:space="preserve">${xml(value)}</t></si>`).join('')}</sst>`);
  zip.remove('xl/calcChain.xml');
  for (const name of ['xl/_rels/workbook.xml.rels', '[Content_Types].xml']) {
    const text = await zip.file(name).async('string');
    zip.file(name, text.replace(/<(?:Relationship|Override)\b[^>]*calcChain[^>]*\/>/g, ''));
  }
  let workbook = await zip.file('xl/workbook.xml').async('string');
  workbook = workbook.replace(/<mc:AlternateContent\b[\s\S]*?<\/mc:AlternateContent>/g, '')
    .replace(/<definedName\b([^>]*)>[\s\S]*?<\/definedName>/g, (all, attrs) => attrs.includes('name="_xlnm.Print_Area"') ? all : '');
  if (shifts.length) workbook = workbook.replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/g,
    (_, start, value, end) => start + shifts.reduce((text, shift) => shift(text), value) + end);
  zip.file('xl/workbook.xml', workbook);
  zip.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>');
  return zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'});
}

const headings = () => new Map([
  ['AA2','담        당'], ['AE2','팀        장'], ['C13','NC'], ['C22',LEGEND]
]);

async function createWorkbook(data, templateBytes) {
  const days = validate(data);
  const staff = data.staff, tcStaff = data.tcStaff || [], dayStaff = data.dayStaff || [];
  // 줄 위치: NC 는 최소 4줄(양식 그대로), TC 는 사람 수만큼(0이면 줄 없음), 일근은 최소 1줄(없으면 숨김).
  const ncRows = Math.max(NC_TEMPLATE_ROWS, staff.length);
  const tcFirst = NC_FIRST + ncRows;
  const dayFirst = tcFirst + tcStaff.length;
  const dayRows = Math.max(1, dayStaff.length);
  const below = (ncRows - NC_TEMPLATE_ROWS) + (tcStaff.length - 1) + (dayRows - 1);
  const cells = new Map([...headings()].map(([address, value]) =>
    [address.replace(/\d+$/, row => Number(row) > DAY_ROW ? Number(row) + below : row), value]));
  const grid = new Map();
  const merges = [];
  cells.set('K6', `${data.month}월  통합관제실 근무표`);
  cells.set('C10', `${data.year}년 ${data.month}월`);
  // 결재칸: 설정의 결재라인 이름(담당 · 팀장)을 그대로 넣는다.
  const [manager, lead] = data.approvalNames || [];
  if (manager) cells.set('AA6', manager);
  if (lead) cells.set('AE6', lead);
  const people = [
    ...staff.map((person, i) => ({ person, row: NC_FIRST + i })),
    ...tcStaff.map((person, i) => ({ person, row: tcFirst + i, label: 'TC' })),
    ...dayStaff.map((person, i) => ({ person, row: dayFirst + i, label: '일근' }))
  ];
  for (const { person, row, label } of people) {
    if (label) cells.set(`C${row}`, label);
    cells.set(`D${row}`, person.name);
  }
  const lastRow = dayFirst + dayRows - 1;
  const offDay = day => {
    const weekday = new Date(Date.UTC(data.year, data.month - 1, day)).getUTCDay();
    return day <= days && (weekday === 0 || weekday === 6 || data.holidays[day - 1]);
  };
  for (let day = 1; day <= 31; day++) {
    const col = column(day + 4);
    const weekday = new Date(Date.UTC(data.year, data.month - 1, day)).getUTCDay();
    const base = offDay(day) ? 'weekend' : 'white';
    if (day <= days) {
      cells.set(`${col}10`, day);
      cells.set(`${col}12`, WEEKDAYS[weekday]);
    }
    for (let row = 10; row <= lastRow; row++) grid.set(`${col}${row}`, { header: row <= 12, fill: base });
  }
  for (const { person, row } of people) {
    for (let day = 1; day <= days; day++) {
      const col = column(day + 4);
      const value = person.shifts[day - 1];
      cells.set(`${col}${row}`, value);
      const kind = person.kinds ? person.kinds[day - 1] : kindOf(value);
      if (kind) grid.set(`${col}${row}`, { header: false, fill: kind });
    }
    // 병합 기간(경조휴가 등): 한 칸으로 합쳐 이름을 한 번만 쓴다.
    for (const span of person.spans || []) {
      const kind = span.kind || kindOf(span.label) || 'custom';
      for (let day = span.start; day <= span.end; day++) {
        const col = column(day + 4);
        cells.set(`${col}${row}`, day === span.start ? span.label : '');
        grid.set(`${col}${row}`, { header: false, fill: kind });
      }
      if (span.end > span.start) merges.push(`${column(span.start + 4)}${row}:${column(span.end + 4)}${row}`);
    }
  }
  return fillTemplate(templateBytes || await fs.readFile(TEMPLATE), cells, grid, {
    ncRows, tcRows: tcStaff.length, dayRows, dayFirst, hideDayRow: !dayStaff.length, merges
  });
}

// Used once when preparing a distributable template; the user's original sample is untouched.
async function cleanTemplate(bytes) { return fillTemplate(bytes, new Map([...headings(), ['C17', 'TC']])); }
module.exports = {createWorkbook, cleanTemplate};
