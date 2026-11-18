// 직원 id → 이름. 완전 삭제된 직원은 employees 에서 빠지므로, 지난 기록(활동 로그·요약 메일)에
// 이름 대신 id 가 찍히지 않도록 삭제 때 남겨 둔 이름표를 차례로 찾아본다.
// 같은 순서를 index.html 의 formerEmployeeName() 도 따른다.
//   1) formerEmployees  — 완전 삭제할 때 남기는 영구 이름표 { id, name, deletedAt }
//   2) deletedEmployeesTrash — 최근 완전 삭제 10건(복구용)
//   3) auditLogs 의 '직원 완전 삭제' 기록 — 이름표가 생기기 전에 삭제된 직원용
function formerEmployeeName(state, id) {
  if (!id || !state) return '';
  const inList = key => (Array.isArray(state[key]) ? state[key] : []).find(e => e && e.id === id)?.name;
  const audit = (Array.isArray(state.auditLogs) ? state.auditLogs : [])
    .find(log => log?.action === '직원 완전 삭제' && log.details?.employee?.id === id);
  return inList('formerEmployees') || inList('deletedEmployeesTrash') || audit?.details.employee.name || '';
}

// 재직 중이면 이름 그대로, 삭제된 직원이면 "이름(삭제됨)", 어디에도 없으면 fallback.
function employeeName(state, id, fallback = '알 수 없음') {
  const current = (Array.isArray(state?.employees) ? state.employees : []).find(e => e && e.id === id);
  if (current?.name) return current.name;
  const former = formerEmployeeName(state, id);
  return former ? `${former}(삭제됨)` : fallback;
}

module.exports = { employeeName, formerEmployeeName };
