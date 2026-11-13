import { selectChangeTrace, traceLinkLabels } from './change-trace.mjs';

function textElement(tag, className, text) {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}

export function renderChangeTrace(container, { frame, path, openOriginal }) {
  const trace = selectChangeTrace(frame, path);
  const region = textElement('section', 'change-trace', ''); container.append(region);
  if (!trace) { region.append(textElement('p', 'coverage', '関連記録：未取得')); return; }
  const trail = [trace.file.id];
  function button(text, action, className = 'panel-action') {
    const node = textElement('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node;
  }
  function render() {
    region.replaceChildren();
    const currentId = trail.at(-1), current = trace.nodes.get(currentId), atFile = currentId === trace.file.id;
    const header = textElement('div', 'trace-heading', '');
    if (!atFile) header.append(button('‹ 戻る', () => { trail.pop(); render(); }));
    header.append(textElement('h3', '', atFile ? '記録' : current.label)); region.append(header);
    if (!atFile) region.append(button(path.split('/').at(-1), () => { trail.splice(1); render(); }, 'trace-home'));
    const record = trace.recordFor(currentId);
    if (record) {
      region.append(textElement('p', 'path', `${record.path} · ${record.revision.slice(0, 7)}`));
      if (current.excerpt) region.append(textElement('p', 'place-summary', current.excerpt));
      region.append(button('原文 ↗', () => openOriginal(record)));
    } else if (current.status === 'uncollected') region.append(textElement('p', 'coverage', '原文未収録'));
    else if (current.kind === 'pr' || current.kind === 'issue') {
      if (current.title) region.append(textElement('p', 'place-summary', current.title));
      const link = textElement('a', 'trace-home', 'GitHub ↗'); link.href = current.url; link.target = '_blank'; link.rel = 'noopener noreferrer'; region.append(link);
      region.append(textElement('p', 'coverage', `関連情報の取得：${trace.fetchedAt || '不明'}`));
    }
    const links = trace.linksFor(currentId).filter(({ target }) => target.kind !== 'file' || target.id === trace.file.id);
    if (atFile && !links.some(({ edge }) => edge.kind === 'file-mention')) region.append(textElement('p', 'coverage', '収録文書内にファイルの明示引用なし'));
    if (atFile && !links.some(({ edge }) => edge.kind === 'merged-pr-change')) region.append(textElement('p', 'coverage', 'PR単独の変更帰属は未確認'));
    const grouped = new Map();
    for (const link of links) {
      if (!grouped.has(link.target.id)) grouped.set(link.target.id, []);
      grouped.get(link.target.id).push(link);
    }
    for (const group of grouped.values()) {
      const { target } = group[0];
      const card = textElement('article', 'trace-card', '');
      card.append(textElement('p', 'coverage', [...new Set(group.map(({ edge, outgoing }) => `${traceLinkLabels[edge.kind]}${edge.kind === 'document-link' ? outgoing ? ' →' : ' ←' : ''}`))].join(' · ')));
      const identifier = target.id.startsWith('doc:') ? `${target.path.split('/').at(-1).replace(/\.md$/, '')} · ` : '';
      card.append(button(identifier + target.label, () => {
        const visited = trail.indexOf(target.id);
        if (visited >= 0) trail.splice(visited + 1); else trail.push(target.id);
        render(); region.scrollIntoView({ block: 'nearest' }); region.querySelector('button')?.focus({ preventScroll: true });
      }, 'trace-link'));
      const details = textElement('details', '', '');
      details.open = atFile && group.some(({ edge }) => edge.kind === 'file-mention');
      details.append(textElement('summary', '', `出所 ${group.length}`));
      for (const { edge } of group) {
      const proof = edge.proof;
      if (proof?.path && proof.quote) {
        details.append(textElement('blockquote', '', proof.quote));
        const source = trace.recordFor(`doc:${proof.path}`);
        const location = `${proof.path}${proof.line ? `:${proof.line}（段落先頭）` : '（行位置未取得）'} · ${proof.revision.slice(0, 7)}`;
        details.append(source ? button(location, () => openOriginal(source), 'trace-source') : textElement('p', 'path', location));
        if (proof.section) details.append(textElement('p', 'coverage', proof.section));
      } else if (proof?.comparisonRevision) details.append(textElement('p', 'path', `${proof.comparisonRevision.slice(0, 7)} → ${proof.revision.slice(0, 7)}`));
      else details.append(textElement('p', 'coverage', `取得：${proof?.fetchedAt || '不明'}`));
      }
      card.append(details);
      region.append(card);
    }
    if (!links.length) region.append(textElement('p', 'coverage', '収録範囲の明示リンクなし'));
    const coverage = trace.coverage;
    region.append(textElement('p', 'coverage', `原文 ${coverage.selected ?? 0} · 未収録 ${coverage.omitted ?? 0} · 取得不可 ${(coverage.unavailable ?? 0) + (coverage.rejected ?? 0)} · 未確認 ${coverage.unexamined ?? 0}`));
  }
  render();
}
