const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');

function loadDigest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digest-'));
  for (const file of ['db.js', 'security.js', 'notifier.js', 'digest.js']) fs.copyFileSync(path.join(root, file), path.join(dir, file));
  const { db } = require(path.join(dir, 'db.js'));
  const digest = require(path.join(dir, 'digest.js'));
  return { digest, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } };
}

const since = Date.parse('2026-09-20T00:00:00Z');
const until = Date.parse('2026-09-21T09:00:00Z');
const before = '2026-09-19T03:00:00Z';
const inside = '2026-09-20T03:00:00Z';

function fixtureState() {
  return {
    settings: { stationName: '통합관제실', lockDay: 25 },
    employees: [
      { id: 'choi', name: '최도인', email: 'choi@sbs.test', endDate: null },
      { id: 'yang', name: '양명국', email: 'Yang@sbs.test', endDate: null },
      { id: 'kimk', name: '김경율', endDate: null },
      { id: 'old', name: '퇴사자', email: 'old@sbs.test', endDate: '2026-08-31' }
    ],
    approvers: [{ id: 'ap1', name: '팀장', email: 'lead@sbs.test', scope: '' }],
    requests: [
      {
        id: 'r1', empId: 'choi', type: 'set', startDate: '2026-09-24', submittedAt: inside, status: 'pending',
        chain: [{ date: '2026-09-24', empId: 'choi', label: '휴가' }, { date: '2026-09-24', empId: 'yang', label: '대근 투입(야)' }]
      },
      {
        id: 'r2', empId: 'yang', type: 'day', startDate: '2026-09-28', submittedAt: before, status: 'cancelled',
        chain: [{ date: '2026-09-28', empId: 'yang', label: '휴가' }, { date: '2026-09-28', empId: 'choi', label: '대일(일근 대근)' }]
      },
      {
        id: 'r3', empId: 'yang', type: 'day', startDate: '2026-09-30', submittedAt: inside, cancelledAt: inside, status: 'cancelled',
        chain: [{ date: '2026-09-30', empId: 'yang', label: '휴가' }, { date: '2026-09-30', empId: 'choi', label: '대일(일근 대근)' }]
      }
    ],
    protects: [
      { id: 'p1', empId: 'yang', date: '2026-09-26', status: 'rejected', needsApproval: true, reason: '개인 사정', submittedAt: before },
      { id: 'p2', empId: 'choi', date: '2026-09-27', status: 'approved', needsApproval: false, submittedAt: inside }
    ],
    approvals: [
      { id: 'a1', type: 'leave', refId: 'r1', status: 'pending', approverIds: ['ap1'], requestedAt: inside },
      { id: 'a2', type: 'leave', refId: 'r2', status: 'rejected', approverIds: ['ap1'], decidedAt: inside, decisionReason: '인원 부족' },
      { id: 'a3', type: 'protect', refId: 'p1', status: 'rejected', approverIds: ['ap1'], decidedAt: inside, decisionReason: '사전 신청 기한 경과' }
    ],
    excuses: [
      { id: 'e1', empId: 'yang', date: '2026-09-24', reason: '병원 예약 <script>alert(1)</script>', submittedAt: inside }
    ]
  };
}

const opts = { sinceFor: () => since, until, today: '2026-09-21', baseUrl: 'http://10.0.0.1:8000' };

test('일일 요약은 근무자·담당자별로 바뀐 내용만 골라 만든다', () => {
  const { digest, cleanup } = loadDigest();
  try {
    const list = digest.buildDigests(fixtureState(), opts);
    const byEmail = Object.fromEntries(list.map(d => [d.email.toLowerCase(), d]));
    assert.deepEqual(Object.keys(byEmail).sort(), ['choi@sbs.test', 'lead@sbs.test', 'yang@sbs.test']);

    const yang = byEmail['yang@sbs.test'].text;
    assert.match(yang, /9월 24일\(목\) 대근 투입\(야\) — 최도인님 휴가 대근 \[승인 대기 중 \(예정 배정\)\]/);
    assert.match(yang, /해당 월 25일 00시 전까지/);
    assert.match(yang, /휴가 9월 28일\(월\) \(일근\) \[반려 \(사유: 인원 부족\)\]/);
    assert.match(yang, /비번 보장 9월 26일\(토\) \[반려 \(사유: 사전 신청 기한 경과\)\]/);

    const choi = byEmail['choi@sbs.test'].text;
    assert.match(choi, /9월 28일\(월\) 대일\(일근 대근\) — 양명국님 휴가 대근 \[배정 해제\]/);
    assert.doesNotMatch(choi, /9월 30일/, '신청과 동시에 취소된 건은 대근자에게 알리지 않는다');
    assert.doesNotMatch(choi, /25일 00시/, '해제된 배정만 있으면 사유 등록 안내를 붙이지 않는다');
    assert.match(choi, /휴가 9월 24일\(목\) \(야\+조\) \[승인 대기\] — 대근: 9월 24일\(목\) 양명국\(대근 투입\(야\)\)/);
    assert.match(choi, /비번 보장 9월 27일\(일\) \[확정\]/);

    const lead = byEmail['lead@sbs.test'].text;
    assert.match(lead, /최도인 휴가 9월 24일\(목\) \(야\+조\) \[승인 대기\]/);
    assert.match(lead, /양명국 휴가 9월 28일\(월\) \(일근\) \[반려 \(사유: 인원 부족\)\]/);
    assert.match(lead, /양명국 휴가 9월 30일\(수\) \(일근\) \[본인 취소\]/);
    assert.match(lead, /양명국 비번 보장\(월 한도 초과\) 9월 26일\(토\) \[반려/);
    assert.doesNotMatch(lead, /9월 27일/, '한도 안의 자동 확정 비번 보장은 담당자에게 알리지 않는다');
    assert.match(lead, /양명국 — 9월 24일\(목\) 대근 불가 사유 접수/);
    assert.match(lead, /현재 승인 대기 1건/);
    assert.match(lead, /http:\/\/10\.0\.0\.1:8000/);
  } finally { cleanup(); }
});

test('메일 HTML은 신청자가 입력한 값을 이스케이프한다', () => {
  const { digest, cleanup } = loadDigest();
  try {
    const lead = digest.buildDigests(fixtureState(), opts).find(d => d.email === 'lead@sbs.test');
    assert.ok(lead.html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!lead.html.includes('<script>'));
  } finally { cleanup(); }
});

test('이미 발송한 시각 이후로 바뀐 내용이 없으면 메일을 만들지 않는다', () => {
  const { digest, cleanup } = loadDigest();
  try {
    const list = digest.buildDigests(fixtureState(), { ...opts, sinceFor: () => until });
    assert.ok(list.length > 0);
    assert.ok(list.every(d => d.itemCount === 0 && !d.subject));
  } finally { cleanup(); }
});

test('같은 메일 주소가 근무자와 담당자에 모두 있으면 한 통으로 합친다', () => {
  const { digest, cleanup } = loadDigest();
  try {
    const state = fixtureState();
    state.approvers.push({ id: 'ap2', name: '최도인', email: 'CHOI@sbs.test', scope: '양명국' });
    const list = digest.buildDigests(state, opts).filter(d => d.email.toLowerCase() === 'choi@sbs.test');
    assert.equal(list.length, 1);
    assert.match(list[0].text, /내 신청 처리 결과/);
    assert.match(list[0].text, /근무자 휴가·비번 보장 처리 현황/);
    assert.doesNotMatch(list[0].text, /최도인 휴가/, '본인 신청은 담당자 구역에 중복으로 넣지 않는다');
  } finally { cleanup(); }
});
