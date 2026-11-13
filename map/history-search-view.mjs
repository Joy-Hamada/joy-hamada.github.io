import { buildHistorySearchIndex, searchProjectHistory, traceFileHistory } from './history-search.mjs';

const eventLabels = { baseline: '起点に存在・未比較', added: '追加', modified: '変更', deleted: '削除', unknown: '変更内容未判定' };
const element = (tag, className, text = '') => { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; };
const signedBytes = value => `${value > 0 ? '+' : ''}${Number(value).toLocaleString('ja-JP')} B`;

export function createHistorySearch({ dialog, readFrames, onChoose }) {
  if (!dialog || typeof readFrames !== 'function' || typeof onChoose !== 'function') throw new Error('search-dialog-configuration');
  let index = null; let timer; let generation = 0; let disposed = false;
  dialog.classList.add('history-search-dialog');
  const header = element('div', 'dialog-head'); const title = element('h2', '', '検索・質問');
  const closeButton = element('button', 'history-search-close', '×'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', '検索を閉じる');
  header.append(title, closeButton);
  const form = element('form', 'history-search-form');
  const input = element('input', 'history-search-input'); input.type = 'search'; input.maxLength = 300; input.placeholder = 'ファイル、PR、気になること'; input.setAttribute('aria-label', '履歴を検索'); input.autocomplete = 'off';
  const submit = element('button', 'history-search-submit', '検索'); submit.type = 'submit';
  form.append(input, submit);
  const status = element('p', 'history-search-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const content = element('div', 'history-search-content');
  const scope = element('p', 'history-search-scope', '収録済みの履歴・記録から検索 · コード本文とAI回答は未対応');
  dialog.replaceChildren(header, form, status, content, scope);

  function clearSearch() { clearTimeout(timer); generation += 1; }
  function choose(target) {
    clearSearch(); dialog.close();
    onChoose(target);
  }
  function showTrace(path) {
    const trace = traceFileHistory(index, path);
    content.replaceChildren();
    const back = element('button', 'history-search-back', '‹ 検索結果'); back.type = 'button'; back.addEventListener('click', search);
    const heading = element('h3', 'history-search-path', path);
    content.append(back, heading);
    if (trace.status !== 'recorded') { status.textContent = '該当する履歴は未収録'; return; }
    status.textContent = `${trace.events.length}時点 · 収録順`;
    const timeline = element('ol', 'history-search-timeline');
    for (const event of trace.events) {
      const row = element('li', `history-event history-event-${event.status}`);
      const button = element('button', 'history-event-open'); button.type = 'button';
      const label = element('span', 'history-event-label', `${event.label} · ${eventLabels[event.status]}`);
      const summary = element('span', 'history-event-title', event.title);
      const size = event.status === 'baseline' ? `${event.afterBytes.toLocaleString('ja-JP')} B` : event.byteDelta === null ? '差分未判定' : signedBytes(event.byteDelta);
      const detail = element('small', 'history-event-detail', `${size}${event.modeChanged ? ' · mode変更' : ''}${event.status === 'modified' && event.contentChanged && event.byteDelta === 0 ? ' · 同容量の内容変更' : ''}`);
      const proof = element('small', 'history-event-proof', event.fromRevision ? `${event.fromRevision.slice(0, 7)} → ${event.toRevision.slice(0, 7)}` : `${event.toRevision.slice(0, 7)} · 比較元なし`);
      button.append(label, summary, detail, proof);
      if (event.issues.length) button.append(element('small', 'history-event-records', event.issues.map(number => `Issue #${number}`).join(' · ')));
      button.setAttribute('aria-label', `${event.label} ${eventLabels[event.status]} ${path}を開く`);
      button.addEventListener('click', () => choose({ kind: 'file', path, frameIndex: event.frameIndex, revision: event.revision, comparisonMode: event.status === 'deleted' ? 'before' : 'after' }));
      row.append(button); timeline.append(row);
    }
    content.append(timeline);
  }
  function search() {
    clearTimeout(timer);
    if (!index) return;
    const result = searchProjectHistory(index, input.value);
    content.replaceChildren();
    status.textContent = result.status === 'idle' ? `${index.frameCount}時点` : result.total ? `${result.total}件${result.truncated ? ` · ${result.results.length}件を表示` : ''}` : '該当する記録なし';
    if (result.status === 'idle') return;
    for (const match of result.results) {
      const card = element('button', 'history-search-result'); card.type = 'button';
      card.append(element('span', 'history-search-category', `${match.category} · ${match.label}`), element('strong', '', match.title), element('span', 'history-search-excerpt', match.summary));
      if (match.kind === 'record') card.append(element('small', 'history-search-proof', `${match.path} @ ${match.revision.slice(0, 7)}`));
      if (match.kind === 'file') {
        card.append(element('small', 'history-search-proof', '時系列を見る →'));
        card.addEventListener('click', () => showTrace(match.path));
      } else card.addEventListener('click', () => choose({ frameIndex: match.frameIndex, path: match.path, revision: match.revision, kind: match.kind, comparisonMode: 'after' }));
      content.append(card);
    }
  }
  async function open(query = '') {
    if (disposed) return;
    clearSearch(); const ticket = generation; index = null;
    input.value = typeof query === 'string' ? query.slice(0, 300) : '';
    content.replaceChildren(); status.textContent = '読込中…'; submit.disabled = true;
    if (!dialog.open) dialog.showModal(); input.focus();
    try {
      const frames = await readFrames();
      if (ticket !== generation || !dialog.open || disposed) return;
      if (!Array.isArray(frames) || !frames.length) { status.textContent = '履歴未取得'; return; }
      index = buildHistorySearchIndex(frames); search();
    } catch {
      if (ticket !== generation || !dialog.open || disposed) return;
      status.textContent = '取得失敗';
      const retry = element('button', 'history-search-retry', '再試行'); retry.type = 'button'; retry.addEventListener('click', () => open(input.value)); content.append(retry);
    } finally { if (ticket === generation) submit.disabled = !index; }
  }
  const submitSearch = event => { event.preventDefault(); search(); };
  const queueSearch = () => { clearTimeout(timer); timer = setTimeout(search, 160); };
  const close = () => { clearSearch(); if (dialog.open) dialog.close(); };
  closeButton.addEventListener('click', close);
  form.addEventListener('submit', submitSearch);
  input.addEventListener('input', queueSearch);
  dialog.addEventListener('close', clearSearch);
  return { open, close, dispose() { disposed = true; close(); form.removeEventListener('submit', submitSearch); input.removeEventListener('input', queueSearch); dialog.removeEventListener('close', clearSearch); closeButton.removeEventListener('click', close); } };
}
