const labels = {added:'追加', modified:'変更', deleted:'削除'};
const symbols = {added:'＋', modified:'●', deleted:'−'};
const number = value => Number(value).toLocaleString('ja-JP');
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
export function formatComparisonCount(status, count, suffix = '') {
  return status === 'measured' ? `${number(count)}${suffix}` : '未比較';
}
export function unresolvedRebuildPaths(comparison, path = '') {
  return (comparison.unexplainedGitChanges || []).filter(candidate => !path || candidate === path || candidate.startsWith(`${path}/`));
}
export function changeMapTarget(pin, currentTown, beforeTown, mode) {
  const visibleTown = mode === 'before' ? beforeTown : currentTown;
  if(visibleTown?.nodes.has(pin.path))return {mode,path:pin.path};
  if(currentTown.nodes.has(pin.path))return {mode:'after',path:pin.path};
  if(beforeTown?.nodes.has(pin.path))return {mode:'before',path:pin.path};
  return null;
}
function element(tag, className = '', text = '') {
  const node = document.createElement(tag); node.className = className; node.textContent = text; return node;
}
export function revisionLabel(frame) {
  return frame ? frame.pr ? `PR #${frame.pr.number}` : frame.revision.slice(0,7) : '比較元なし';
}
export function summarizeRebuildGroup(comparison, path) {
  if (comparison.status !== 'measured') return '未比較';
  const group = comparison.groups.get(path);
  const change = comparison.changes.find(change => change.path === path);
  const unresolved = unresolvedRebuildPaths(comparison,path).length;
  const known = group && group.added + group.modified + group.deleted > 0 ? `＋${group.added}  ●${group.modified}  −${group.deleted}` : change ? labels[change.status] : '';
  return [known,unresolved ? `未判定 ${unresolved}` : ''].filter(Boolean).join(' · ') || '変更なし';
}
export function buildRebuildPins(town, comparison) {
  const known = comparison.changes.map(change => {
    const node = town.nodes.get(change.path);
    const bytes = change.byteDelta == null ? '' : ` · ${signed(change.byteDelta)} bytes`;
    return {id:`${comparison.toRevision}:${change.path}`,kind:'change',path:change.path,nodeId:change.path,
      revision:comparison.toRevision,comparisonRevision:comparison.fromRevision,
      label:labels[change.status],change:change.status,before:change.before,after:change.after,
      world:node ? {x:node.center.x,y:node.center.y} : null,
      summary:`${labels[change.status]}${bytes}`,basis:'revision-inventory'};
  });
  return [...known,...unresolvedRebuildPaths(comparison).map(path => {
    const node=town.nodes.get(path);
    return {id:`${comparison.toRevision}:${path}`,kind:'change',path,nodeId:path,
      revision:comparison.toRevision,comparisonRevision:comparison.fromRevision,label:'変更内容未判定',change:'unknown',before:null,after:node,
      world:node?.center || null,summary:'Gitに変更記録あり · 内容未判定',basis:'git-change-with-incomplete-inventory'};
  })].sort((a,b)=>a.path.localeCompare(b.path));
}
export function renderRebuildPlace(container, {town, beforeTown, comparison, path, mode, beforeFrame, afterFrame, navigate, chooseChange, focus}) {
  const visibleTown = mode === 'before' && beforeTown ? beforeTown : town;
  const node = visibleTown.nodes.get(path) || visibleTown.root;
  const before = beforeTown?.nodes.get(node.path), after = town.nodes.get(node.path);
  container.append(element('p','path',node.path || '/'),element('p','coverage',`${revisionLabel(beforeFrame)} → ${revisionLabel(afterFrame)} · 前の表示版比`));
  const metrics = element('dl','rebuild-metrics');
  for (const [label,value] of [
    ['ファイル',comparison.status === 'measured' ? `${number(before?.fileCount || 0)} → ${number(after?.fileCount || 0)}` : number(after?.fileCount || 0)],
    ['容量',comparison.status === 'measured' ? `${signed((after?.bytes || 0) - (before?.bytes || 0))} bytes` : `${number(after?.bytes || 0)} bytes`],
    ['差分',summarizeRebuildGroup(comparison,node.path)]
  ]) metrics.append(element('dt','',label),element('dd','',value));
  container.append(metrics);
  const zoom = element('button','panel-action','地図で表示'); zoom.addEventListener('click',()=>focus(node.id));container.append(zoom);
  const ownChanges = node.type === 'file' ? comparison.changes.filter(change => change.path === node.path) : comparison.groups.get(node.path)?.changes || [];
  const list = element('div','rebuild-change-list');
  const unresolved = unresolvedRebuildPaths(comparison,node.path);
  const title = element('h3','',`差分 ${formatComparisonCount(comparison.status,ownChanges.length)}${unresolved.length ? ` · 未判定 ${unresolved.length}` : ''}`); container.append(title,list);
  if (comparison.status !== 'measured') list.append(element('p','coverage','未比較'));
  else if (!ownChanges.length && !unresolved.length) list.append(element('p','coverage','変更なし'));
  for (const change of ownChanges) {
    const button = element('button','pin-list-item'); button.type='button';
    button.append(element('span','pin-kind',symbols[change.status]),element('span','',change.path),element('small','',`${signed(change.byteDelta)} B`));
    button.setAttribute('aria-label',`${labels[change.status]} ${change.path}`);
    button.addEventListener('click',()=>chooseChange(change.path)); list.append(button);
  }
  for(const path of unresolved){const button=element('button','pin-list-item',`? ${path} · 変更内容未判定`);button.type='button';button.addEventListener('click',()=>chooseChange(path));list.append(button);}
  if (node.children.length) {
    const title = element('h3','',mode === 'before' ? '前の構成' : '構成'); container.append(title);
    for (const id of node.children) {
      const child=visibleTown.nodes.get(id), button=element('button','child'); button.type='button';
      button.append(element('span','name',child.name),element('span','count',child.type === 'folder' ? `${child.fileCount} ↗` : '↗'));
      button.addEventListener('click',()=>navigate(id)); container.append(button);
    }
  }
  const limits=element('details','rebuild-evidence'); limits.append(element('summary','','比較データ'));
  limits.append(element('p','coverage',`${comparison.fromRevision || '—'} → ${comparison.toRevision}`),element('p','coverage','移動の対応・行差分・機能差分は未取得'));
  if(comparison.modeCoverage !== 'complete') limits.append(element('p','coverage','ファイル権限の比較：未取得を含む'));
  if(comparison.unexplainedGitChanges?.length) limits.append(element('p','coverage',`Gitの変更記録 ${comparison.unexplainedGitChanges.length}件は内容未判定`));
  container.append(limits);
}
