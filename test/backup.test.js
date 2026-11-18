// 서버 PC 로컬 백업(backup.js): 매일 DB 사본과 월 확정 엑셀·JSON. 모두 임시 폴더에서만 만든다.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const JSZip = require('jszip');
const { runDailyBackup, saveMonthlyBackup, kst } = require('../backup');

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

test('매일 DB 사본: 하루 한 번만 만들고, 열면 같은 데이터가 있으며, 보관 기간이 지난 사본은 지운다', t => {
  const dir = tempDir(t, 'nqc-backup-');
  const db = new DatabaseSync(path.join(dir, 'source.db'));
  db.exec("CREATE TABLE kv_store (key TEXT PRIMARY KEY, value TEXT); INSERT INTO kv_store VALUES ('schedule_state', '{\"employees\":[]}')");
  const backupTo = file => db.prepare('VACUUM INTO ?').run(file);
  const out = path.join(dir, 'backups');
  fs.mkdirSync(path.join(out, 'daily'), { recursive: true });
  for (const name of ['geunmupyo-2026-10-01.db', 'geunmupyo-2026-11-01.db', 'memo.txt']) fs.writeFileSync(path.join(out, 'daily', name), 'old');

  const now = new Date('2026-11-18T05:00:00Z'); // 한국 시간 14:00
  const file = runDailyBackup({ backupTo, now, dir: out, keep: 30 });
  assert.equal(path.basename(file), 'geunmupyo-2026-11-18.db');
  const copy = new DatabaseSync(file, { readOnly: true });
  assert.equal(copy.prepare("SELECT value FROM kv_store WHERE key='schedule_state'").get().value, '{"employees":[]}');
  copy.close();
  // 같은 날 다시 불러도 덮어쓰지 않는다.
  assert.equal(runDailyBackup({ backupTo, now, dir: out, keep: 30 }), null);
  assert.deepEqual(fs.readdirSync(path.join(out, 'daily')).sort(), ['geunmupyo-2026-11-01.db', 'geunmupyo-2026-11-18.db', 'memo.txt']);
  db.close();
});

test('한국 시간 기준으로 날짜가 바뀐다', () => {
  assert.equal(kst(new Date('2026-11-17T15:30:00Z')).date, '2026-11-18');
  assert.equal(kst(new Date('2026-11-17T15:30:00Z')).stamp, '20261118-0030');
});

function excelPayload() {
  return { year: 2026, month: 12, holidays: Array(31).fill(false), tcStaff: [],
    staff: ['최도인', '양명국', '정재승', '김건호'].map(name => ({ name, shifts: Array(31).fill('일') })) };
}

test('월 확정본: 화면 [엑셀]과 같은 양식의 xlsx 와 JSON 을 남긴다', async t => {
  const dir = tempDir(t, 'nqc-monthly-');
  const version = { monthKey: '2026-12', number: 2, approverName: '담당', at: '2026-11-25T09:30:00Z',
    snapshot: { monthKey: '2026-12', employees: [], excel: excelPayload() } };
  const files = await saveMonthlyBackup(version, { dir });
  assert.deepEqual(files.map(f => path.basename(f)), ['2026-12_확정2차_20261125-1830.json', '2026-12_확정2차_20261125-1830.xlsx']);
  const saved = JSON.parse(fs.readFileSync(files[0], 'utf8'));
  assert.equal(saved.approverName, '담당');
  const zip = await JSZip.loadAsync(fs.readFileSync(files[1]));
  assert.match(await zip.file('xl/sharedStrings.xml').async('string'), /최도인/);
});

test('월 확정본: 엑셀 데이터가 없는 예전 요청은 JSON 만 남긴다', async t => {
  const dir = tempDir(t, 'nqc-monthly-');
  const files = await saveMonthlyBackup({ monthKey: '2026-10', number: 1, at: '2026-10-25T00:00:00Z', snapshot: { employees: [] } }, { dir });
  assert.deepEqual(files.map(f => path.extname(f)), ['.json']);
});
