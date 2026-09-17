// SQLite 저장소. Node.js 내장 node:sqlite 모듈을 사용해 별도 네이티브 빌드 없이 동작한다.
// (Node 22.5+ 필요. package.json의 engines 참고)
//
// Phase 1 범위: 근무표 전체 상태(STATE)를 JSON 하나로 kv_store에 저장/조회한다.
// 이는 기존 localStorage(ncq_schedule_v1)를 그대로 서버로 옮긴 것과 같아서,
// index.html의 기존 로직(2000줄 이상)을 건드리지 않고도 여러 브라우저가 같은
// 데이터를 공유하게 해준다. approvers/approvals 같은 정규화된 테이블은
// Phase 2에서 추가한다.

const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = path.join(__dirname, 'geunmupyo.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
`);

// 기존 DB도 데이터 이동 없이 사용한다. 과거 상태는 버전 1부터 시작한다.
if (!db.prepare('PRAGMA table_info(kv_store)').all().some(column => column.name === 'revision')) {
  db.exec('ALTER TABLE kv_store ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
}

const STATE_KEY = 'schedule_state';

function getState() {
  const row = db.prepare('SELECT value, updated_at, revision FROM kv_store WHERE key = ?').get(STATE_KEY);
  if (!row) return null;
  // 손상된 DB를 빈 DB로 오인해 초기값으로 덮어쓰지 않는다.
  return { state: JSON.parse(row.value), updatedAt: row.updated_at, revision: row.revision };
}

const insertStmt = db.prepare(`
  INSERT OR IGNORE INTO kv_store (key, value, updated_at, revision) VALUES (?, ?, ?, 1)
`);
const updateStmt = db.prepare(`
  UPDATE kv_store SET value = ?, updated_at = ?, revision = revision + 1
  WHERE key = ? AND revision = ?
`);

function setState(stateObj, baseRevision) {
  if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw new Error('Invalid base revision');
  const updatedAt = new Date().toISOString();
  const value = JSON.stringify(stateObj);
  // 버전 검사와 쓰기를 한 SQL에서 처리해 별도 연결의 동시 저장도 보호한다.
  const result = baseRevision === 0
    ? insertStmt.run(STATE_KEY, value, updatedAt)
    : updateStmt.run(value, updatedAt, STATE_KEY, baseRevision);
  if (result.changes !== 1) return null;
  return { updatedAt, revision: baseRevision + 1 };
}

module.exports = { db, getState, setState };
