const dependentControls = ['previous','next','pr-chip','place-chip','pins-chip','view-chip','question-search','issue-summary','sdd-tab','adr-tab','project-home','project-chip','map-info','journey-play'];
export function renderMapLoadState(document, status) {
  const ready = status === 'ready';
  const label = status === 'failed' ? '取得失敗' : status === 'drawing-failed' ? '描画失敗' : '読込中…';
  for (const id of dependentControls) {
    const control = document.getElementById(id);
    if (control && (!ready || !['previous','next'].includes(id))) control.disabled = !ready;
  }
  if (ready) return;
  for (const control of document.querySelectorAll('[data-comparison]')) control.disabled = true;
  for (const id of ['pins-count','pr-value','sdd-status','adr-status']) document.getElementById(id).textContent = label;
  document.getElementById('issue-summary-text').textContent = status === 'loading' ? '読込中…' : '記録未取得';
  for (const id of ['frame-count','record-revision','issue-number','frame-date','comparison-label','data-scope']) document.getElementById(id).textContent = '';
  document.getElementById('context-label').textContent = 'Issue';
  document.getElementById('return-issue').hidden = true;
  document.getElementById('panel-content').replaceChildren();
  document.getElementById('history-data').replaceChildren();
  document.getElementById('breadcrumbs').replaceChildren();
  document.getElementById('place-value').textContent = '全体';
}
