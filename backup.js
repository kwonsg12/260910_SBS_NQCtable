// 서버 PC 로컬 백업. 서버가 고장 나거나 데이터가 날아갔을 때를 대비해 두 가지를 남긴다.
//   1) 매일 DB 전체 사본: BACKUP_DIR/daily/geunmupyo-YYYY-MM-DD.db
//      직원·신청·승인·PIN 해시까지 전부 들어 있어, 이 파일을 geunmupyo.db 로 바꿔 넣으면 그날 상태로 돌아간다.
//      BACKUP_KEEP_DAYS(기본 30일)보다 오래된 사본은 지운다.
//   2) 월 근무표 확정본: BACKUP_DIR/monthly/YYYY-MM_확정N차_YYYYMMDD-HHMM.xlsx (+ 같은 이름의 .json)
//      확정이 승인되는 순간 만든다. 엑셀은 화면 [엑셀] 버튼과 같은 양식이며, 지우지 않는다.
//
// 실행: 서버(server.js)가 startBackupScheduler() 로 자동 실행한다.
//       지금 바로 DB 사본을 만들려면: npm run backup
//
// 서버 PC 자체가 고장 나는 경우까지 대비하려면 .env 의 BACKUP_DIR 을 OneDrive 폴더나 외장 드라이브로 지정한다.

require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function backupDir() {
  return path.resolve(__dirname, process.env.BACKUP_DIR || 'backups');
}
function keepDays() {
  const days = Number(process.env.BACKUP_KEEP_DAYS);
  return Number.isInteger(days) && days >= 1 ? days : 30;
}
function backupTime() {
  return TIME_PATTERN.test(process.env.BACKUP_TIME || '') ? process.env.BACKUP_TIME : '03:00';
}

// 한국 시간 기준 날짜(YYYY-MM-DD)와 시각(HH:MM). 서버 PC 시간대 설정과 상관없이 같게 나온다.
function kst(date = new Date()) {
  const iso = new Date(date.getTime() + 9 * 60 * 60 * 1000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), stamp: iso.slice(0, 10).replace(/-/g, '') + '-' + iso.slice(11, 16).replace(':', '') };
}

const DAILY_PATTERN = /^geunmupyo-(\d{4}-\d{2}-\d{2})\.db$/;

// 오늘 사본이 없을 때만 만든다. 만들었으면 파일 경로, 이미 있으면 null.
function runDailyBackup({ backupTo, now = new Date(), dir = backupDir(), keep = keepDays() }) {
  const dailyDir = path.join(dir, 'daily');
  fs.mkdirSync(dailyDir, { recursive: true });
  const today = kst(now).date;
  const file = path.join(dailyDir, `geunmupyo-${today}.db`);
  let created = null;
  if (!fs.existsSync(file)) {
    // 쓰다가 꺼져도 반쪽 파일이 '오늘 백업'으로 남지 않도록 임시 이름으로 만든 뒤 바꾼다.
    const temp = file + '.tmp';
    fs.rmSync(temp, { force: true });
    backupTo(temp);
    fs.renameSync(temp, file);
    created = file;
  }
  pruneDaily(dailyDir, today, keep);
  return created;
}

function pruneDaily(dailyDir, today, keep) {
  const cutoff = new Date(Date.parse(today + 'T00:00:00Z') - keep * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const name of fs.readdirSync(dailyDir)) {
    const match = DAILY_PATTERN.exec(name);
    if (match && match[1] < cutoff) fs.rmSync(path.join(dailyDir, name), { force: true });
  }
}

function safeName(value) {
  return String(value).replace(/[^0-9A-Za-z가-힣_-]/g, '_');
}

// 확정 승인으로 생긴 버전(security.decide 가 넘겨준다)을 엑셀과 JSON 으로 남긴다.
// 예전 화면에서 올린 확정 요청처럼 엑셀 데이터(snapshot.excel)가 없으면 JSON 만 남긴다.
async function saveMonthlyBackup(version, { dir = backupDir(), createWorkbook = require('./excel-export').createWorkbook } = {}) {
  const monthlyDir = path.join(dir, 'monthly');
  fs.mkdirSync(monthlyDir, { recursive: true });
  const base = path.join(monthlyDir, `${safeName(version.monthKey)}_확정${Number(version.number) || 1}차_${kst(new Date(version.at || Date.now())).stamp}`);
  fs.writeFileSync(base + '.json', JSON.stringify({
    monthKey: version.monthKey, number: version.number, approverName: version.approverName, at: version.at, snapshot: version.snapshot
  }, null, 2), 'utf8');
  const files = [base + '.json'];
  if (version.snapshot?.excel) {
    fs.writeFileSync(base + '.xlsx', await createWorkbook(version.snapshot.excel));
    files.push(base + '.xlsx');
  } else {
    console.warn(`[백업] ${version.monthKey} 확정본에 엑셀 데이터가 없어 JSON 만 저장했습니다. (예전 화면에서 올린 확정 요청)`);
  }
  console.log(`[백업] ${version.monthKey} 확정 ${version.number}차 저장 → ${files.map(f => path.basename(f)).join(', ')}`);
  return files;
}

function startBackupScheduler({ backupTo }) {
  const time = backupTime();
  const dir = backupDir();
  const run = reason => {
    try {
      const file = runDailyBackup({ backupTo, dir });
      if (file) console.log(`[백업] DB 사본 저장(${reason}) → ${file}`);
    } catch (error) {
      console.error('[백업] DB 사본 저장 실패:', error.message);
    }
  };
  // 켤 때 오늘 사본이 없으면 바로 하나 만들고, 그 뒤로는 매일 정해진 시각이 지나면 만든다.
  run('서버 시작');
  const timer = setInterval(() => { if (kst().time >= time) run('정기'); }, 10 * 60 * 1000);
  timer.unref?.();
  console.log(`로컬 백업: ${dir} — 매일 ${time}(한국 시간) DB 사본(${keepDays()}일 보관), 월 확정 승인 시 엑셀`);
}

module.exports = { runDailyBackup, saveMonthlyBackup, startBackupScheduler, kst, backupDir };

if (require.main === module) {
  const { backupTo } = require('./db');
  const file = runDailyBackup({ backupTo });
  console.log(file ? `DB 사본 저장 → ${file}` : '오늘 사본이 이미 있습니다.');
}
