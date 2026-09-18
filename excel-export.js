'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const JSZip = require('jszip');
const TEMPLATE = path.join(__dirname, 'templates', 'schedule.xlsx');
const SHEET = 'xl/worksheets/sheet1.xml';
const LEGEND = '[일: 09:00 ~ 18:30 ,   야: 18:00 ~ 00:00 ,  조: 00:00 ~ 09:00 ,   O:비번]';
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
const xml = value => String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function column(n) {
  let result = '';
  while (n) { result = String.fromCharCode(65 + (n - 1) % 26) + result; n = Math.floor((n - 1) / 26); }
  return result;
}

function validate(data) {
  const fail = () => { const e = new Error('엑셀 출력 데이터가 올바르지 않습니다.'); e.status = 400; throw e; };
  if (!data || !Number.isInteger(data.year) || data.year < 1900 || data.year > 9999 ||
      !Number.isInteger(data.month) || data.month < 1 || data.month > 12) fail();
  const days = new Date(Date.UTC(data.year, data.month, 0)).getUTCDate();
  if (data.dayWorkerName !== undefined && (typeof data.dayWorkerName !== 'string' || data.dayWorkerName.length > 50)) fail();
  if (!Array.isArray(data.staff) || data.staff.length > 4) fail();
  if (data.tcStaff !== undefined && (!Array.isArray(data.tcStaff) || data.tcStaff.length > 100)) fail();
  for (const person of [...data.staff, ...(data.tcStaff || [])]) {
    if (!person || typeof person.name !== 'string' || !person.name.trim() || person.name.length > 50 ||
        !Array.isArray(person.shifts) || person.shifts.length !== days ||
        person.shifts.some(v => typeof v !== 'string' || v.length > 20)) fail();
  }
  if (!Array.isArray(data.holidays) || data.holidays.length !== days || data.holidays.some(v => typeof v !== 'boolean')) fail();
  return days;
}

// Only the checked-in, fixed template is processed here; uploaded workbooks are never accepted.
// Replace cell contents while keeping widths, heights, merges, borders and printer settings intact.
async function fillTemplate(bytes, cells, grid = new Map(), tcCount = null) {
  const zip = await JSZip.loadAsync(bytes);
  let styles = await zip.file('xl/styles.xml').async('string');
  const styleBlock = styles.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/);
  const xfs = styleBlock[1].match(/<xf\b[^>]*?(?:\/>|>[\s\S]*?<\/xf>)/g);
  const cache = new Map();
  const strings = [];
  const stringIds = new Map();
  let stringCount = 0;
  let sheet = await zip.file(SHEET).async('string');
  const delta = tcCount === null ? 0 : tcCount - 1;
  const shiftReferences = text => text.replace(/(\$?[A-Z]+\$?)(\d+)/g,
    (_, col, row) => col + (Number(row) > 17 ? Number(row) + delta : row));
  if (delta) {
    const tcRow = sheet.match(/<row\b[^>]*\br="17"[^>]*>[\s\S]*?<\/row>/)[0];
    sheet = sheet.replace(/\br="([A-Z]*)(\d+)"/g, (_, col, row) => `r="${col}${Number(row) > 17 ? Number(row) + delta : row}"`)
      .replace(/\b(ref|sqref|activeCell|topLeftCell)="([^"]*)"/g, (_, key, value) => `${key}="${shiftReferences(value)}"`);
    sheet = sheet.replace(tcRow, Array.from({length:tcCount}, (_, i) =>
      tcRow.replace(/\br="([A-Z]*)17"/g, (_, col) => `r="${col}${17 + i}"`)).join(''));
  }
  const seen = new Set();
  sheet = sheet.replace(/<c\b([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, (whole, attrs) => {
    const address = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!address) throw new Error('엑셀 양식의 셀 주소를 읽을 수 없습니다.');
    seen.add(address);
    let style = Number(/\bs="(\d+)"/.exec(attrs)?.[1] || 0);
    const format = grid.get(address);
    if (format) {
      const original = xfs[style];
      const border = /\bborderId="(\d+)"/.exec(original)?.[1] || '0';
      const key = `${format.header}:${format.fill}:${border}`;
      if (!cache.has(key)) {
        const base = xfs[format.header ? 62 : 64].replace(/\bborderId="\d+"/, `borderId="${border}"`)
          .replace(/\bfillId="\d+"/, `fillId="${format.fill}"`);
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
  if (delta) workbook = workbook.replace(/(<definedName\b[^>]*>)([\s\S]*?)(<\/definedName>)/g,
    (_, start, value, end) => start + shiftReferences(value) + end);
  zip.file('xl/workbook.xml', workbook);
  zip.file('docProps/core.xml', '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"/>');
  return zip.generateAsync({type:'nodebuffer', compression:'DEFLATE'});
}

const headings = () => new Map([
  ['AA2','담        당'], ['AE2','팀        장'], ['C13','NC'], ['C17','TC'], ['C18','일근'], ['C22',LEGEND],
  ['AM10','<휴가신청절차>'], ['AL12','1)'], ['AM12','휴가\n신청'], ['AO12','휴가신청'],
  ['AL14','2-1)'], ['AM14','대일'], ['AO14','대근 해당자가 직접 표기'], ['AM15','휴가']
]);

async function createWorkbook(data, templateBytes) {
  const days = validate(data);
  const tcStaff = data.tcStaff || [];
  const delta = tcStaff.length - 1;
  const cells = new Map([...headings()].filter(([address]) => address !== 'C17').map(([address, value]) =>
    [address.replace(/\d+$/, row => Number(row) > 17 ? Number(row) + delta : row), value]));
  const dayRow = 18 + delta;
  const grid = new Map();
  cells.set('K6', `${data.month}월  통합관제실 근무표`);
  cells.set('C10', `${data.year}년 ${data.month}월`);
  cells.set(`D${dayRow}`, data.dayWorkerName?.trim() || '서예찬');
  tcStaff.forEach((person, i) => { cells.set(`C${17 + i}`, 'TC'); cells.set(`D${17 + i}`, person.name); });
  data.staff.forEach((person, i) => cells.set(`D${13 + i}`, person.name));
  for (let day = 1; day <= 31; day++) {
    const col = column(day + 4);
    const weekday = new Date(Date.UTC(data.year, data.month - 1, day)).getUTCDay();
    const off = day <= days && (weekday === 0 || weekday === 6 || data.holidays[day - 1]);
    if (day <= days) {
      cells.set(`${col}10`, day);
      cells.set(`${col}12`, WEEKDAYS[weekday]);
      cells.set(`${col}${dayRow}`, off ? 'O' : '일');
      tcStaff.forEach((person, i) => cells.set(`${col}${17 + i}`, person.shifts[day - 1]));
      data.staff.forEach((person, i) => cells.set(`${col}${13 + i}`, person.shifts[day - 1]));
    }
    for (let row = 10; row <= dayRow; row++) {
      const value = cells.get(`${col}${row}`);
      grid.set(`${col}${row}`, {header:row <= 12, fill:value === '휴가' ? 3 : off ? 6 : 2});
    }
  }
  return fillTemplate(templateBytes || await fs.readFile(TEMPLATE), cells, grid, tcStaff.length);
}

// Used once when preparing a distributable template; the user's original sample is untouched.
async function cleanTemplate(bytes) { return fillTemplate(bytes, headings()); }
module.exports = {createWorkbook, cleanTemplate};
