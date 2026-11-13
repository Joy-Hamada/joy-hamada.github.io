import { buildStrataModel } from './strata-model.mjs';
import { verifyHistoryMapSnapshots } from './map-snapshot.mjs';
import { verifyAncestralHistory } from './ancestral-history.mjs';
import { traceProjectMapAncestors } from './model.mjs';
import { createLatestProjectMapReader } from './navigation.mjs';
import { summarizeStrataPlace, describeStrataActivity, resolveJourneyFrame } from './journey-ui.mjs';
import { buildMobileRecords } from './mobile-records.mjs';
import { createRecordLoader, applyFrameRecords, releaseFrameRecords } from './record-loader.mjs';
import { buildMapPins } from './map-pins.mjs';
import { renderChangeTrace } from './change-trace-view.mjs';
import { defaultMapPaletteId, colorForMapPalette } from './map-palette.mjs';
import { renderMapLoadState } from './map-load-state.mjs';
import { buildRevisionLibrary } from './library-model.mjs';
import { createHistorySearch } from './history-search-view.mjs';
import { buildRevisionTown, compareRevisionTrees } from './rebuild-model.mjs';
import { buildRebuildPins, renderRebuildPlace, revisionLabel, summarizeRebuildGroup, changeMapTarget, formatComparisonCount } from './rebuild-panel.mjs';

const byId = id => document.getElementById(id);
const number = value => Number(value).toLocaleString('ja-JP');
const historyEndpoint = document.querySelector('meta[name="xozu-history"]')?.content || '/api/project-strata';
const sourceAvailable = document.querySelector('meta[name="xozu-source-access"]')?.content !== 'unavailable';
let model, scene, records, activeSource, noticeTimer;
let frameIndex = 0, selectedId = '', regionId = '', loadTicket = 0, panelKind = 'issue';
let sheetExpanded = false, sheetDrag = null, suppressHandleClick = false;
let pins = [], activePin = null, pinGroup = null;
let pinVisibility = {offscreen:0,unplaced:0};
let recordState = { revision: null, status: 'ready' };
let viewMode = 'library', comparisonMode = 'diff', sceneTicket = 0;
let libraryProjection = '3D';
let towns = new Map(), comparisons = new Map();
let journeyTimer;
let mapLoadStatus='loading',pendingSearchRecord=null;
function showMapLoadState(status){
  mapLoadStatus=status;
  if(status!=='ready'){
    recordLoader.cancel();stopJourney();pendingSearchRecord=null;
    for(const id of ['picker-dialog','data-dialog','source-dialog','history-search-dialog'])byId(id).close();
    if(status==='failed'||status==='drawing-failed'){++sceneTicket;scene?.dispose();scene=undefined;showPlaceHover(null);}
  }
  renderMapLoadState(document,status);
}
function stopJourney() { clearInterval(journeyTimer); journeyTimer=undefined; const button=byId('journey-play');button.textContent='▷';button.setAttribute('aria-label','履歴を再生');button.setAttribute('aria-pressed','false'); }
function usesCurrentInventory() { return viewMode !== 'strata'; }
const recordLoader = createRecordLoader();
const paletteId = defaultMapPaletteId;
try { localStorage.removeItem('xozu-map-palette'); } catch {}
const sheet = byId('record-sheet');
function element(tag, className = '', text = '') { const node = document.createElement(tag); node.className = className; node.textContent = text; return node; }
function notify(text) { clearTimeout(noticeTimer); byId('notice').textContent = text || ''; byId('notice').hidden = !text; if (text) noticeTimer = setTimeout(() => { byId('notice').hidden = true; }, 6500); }
function frame() { return model.frames[frameIndex]; }
function town(index = frameIndex) { if(index < 0)return null; const key=`${viewMode}:${index}`; if(!towns.has(key))towns.set(key,viewMode.startsWith('library')?buildRevisionLibrary(model.frames[index]):buildRevisionTown(model.frames[index]));return towns.get(key); }
function comparison() { if(!comparisons.has(frameIndex))comparisons.set(frameIndex,compareRevisionTrees(model.frames[frameIndex-1] || null,frame()));return comparisons.get(frameIndex); }
function comparisonStatus() { return frameIndex === 0 ? 'unknown' : usesCurrentInventory() ? comparison().status : frame().changes.status; }
function visibleMap() { return usesCurrentInventory() ? town(comparisonMode === 'before' && frameIndex > 0 ? frameIndex-1 : frameIndex) : model.map; }
function updateHash() { history.replaceState(null, '', `${location.pathname}#${new URLSearchParams({revision:frame().revision,path:selectedId,mode:'explore',view:viewMode,compare:comparisonMode})}`); }
function openDialog(id) { if (!byId(id).open) byId(id).showModal(); }
function setSheet(expanded) {
  sheetExpanded = expanded; sheet.dataset.snap = expanded ? 'expanded' : 'peek'; sheet.dataset.dragging = 'false';
  const {peek,max} = sheetLimits(); sheet.style.height = `${expanded ? max : peek}px`;
  byId('sheet-body').inert = !expanded; byId('sheet-handle').setAttribute('aria-expanded', String(expanded));
  byId('sheet-handle').setAttribute('aria-label', expanded ? '記録を小さくする' : '記録を引き上げる');
}
function sheetLimits() {
  const headerBottom = document.querySelector('.map-header').getBoundingClientRect().bottom;
  const max = Math.max(80, innerHeight - headerBottom - 72 - (innerWidth >= 800 ? 18 : 0));
  const peek = Math.min(max, innerHeight<=440&&innerWidth<800?130:Infinity, byId('sheet-top').getBoundingClientRect().height + 12);
  if(!activePin&&panelKind!=='pins')document.documentElement.style.setProperty('--peek-height', `${peek}px`);
  return {peek,max};
}
function restoreIssue() { if(mapLoadStatus!=='ready')return;activePin=null;pinGroup=null;selectedId='';scene?.setSelected('');scene?.setActivePins([]);panelKind='issue';updateHash();renderHeading();renderPanel();setSheet(false); }
function choosePin(selection) {
  if(mapLoadStatus!=='ready')return;
  if ((selection.members || [selection]).some(pin => pin.revision !== frame().revision)) return;
  if (selection.members?.length > 1) { pinGroup=selection.members;activePin=null;scene?.setActivePins(pinGroup.map(pin=>pin.id));panelKind='pins';renderHeading();openPanel('pins');return; }
  const pin=selection.members?.[0] || selection;
  if(pin.revision!==frame().revision)return;
  if(pin.kind==='issue'){restoreIssue();openPanel('issue');scene?.setActivePins([pin.id]);return;}
  activePin=pin;pinGroup=null;panelKind='pin';selectedId=pin.nodeId;scene?.setSelected(selectedId);scene?.setActivePins([pin.id]);updateHash();renderHeading();renderPanel();setSheet(true);
}
function renderHeading() {
  if(!records)return;
  const isPin=!!activePin, isGroup=panelKind==='pins', isPlace=usesCurrentInventory()&&panelKind==='place';
  byId('record-revision').textContent=`${revisionLabel(frame())}${usesCurrentInventory()&&comparisonMode==='before'?'（後）':''} の記録`;
  byId('context-label').textContent=isPin?(activePin.kind==='change'?'変更':activePin.kind.toUpperCase()):isGroup?'差分':isPlace?'構成':'Issue';
  byId('issue-number').textContent=isPin?activePin.path:isGroup?formatComparisonCount(comparisonStatus(),(pinGroup||pins).length,'件'):isPlace?selectedId||'/':records.issue.relatedIssues.map(issue=>`#${issue.number}`).join(' · ') || '—';
  byId('issue-summary-text').textContent=isPin?activePin.summary:isGroup?(comparisonStatus()==='measured'?'変更':'未比較'):isPlace?summarizeRebuildGroup(comparison(),selectedId):records.issue.summary;
  byId('return-issue').hidden=!isPin&&!isGroup&&!isPlace;
  byId('document-shortcuts').hidden=isPin||isGroup||isPlace;
  byId('issue-summary').setAttribute('aria-label',isPin?'選択したピンの詳細':'Issueの要約と原文');
  requestAnimationFrame(()=>{if(!sheetDrag)setSheet(sheetExpanded);});
}
function openPanel(kind) { if(mapLoadStatus!=='ready')return;if(!['pin','pins'].includes(kind)){activePin=null;pinGroup=null;scene?.setActivePins([]);} panelKind = kind;renderHeading(); renderPanel(); setSheet(true); byId('sheet-body').scrollTop = 0; }
function updateLocation(id) {
  const map = model && visibleMap(); const candidate = map?.nodes.get(id); if (!candidate) return;
  regionId = candidate.type === 'file' ? candidate.parentId : id;
  const breadcrumbs = byId('breadcrumbs'); breadcrumbs.replaceChildren();
  for (const [index, node] of traceProjectMapAncestors(map, regionId).entries()) {
    if (index) breadcrumbs.append(element('span', '', '/'));
    const button = element('button', '', node.name); button.title = node.path || 'XOZU'; button.addEventListener('click', () => navigate(node.id)); breadcrumbs.append(button);
  }
  byId('place-value').textContent = candidate.id ? candidate.name : '全体';
}
function navigate(id) { if (mapLoadStatus!=='ready'||!model || !visibleMap().nodes.has(id)) return; selectNode(id, true); scene?.focus(id); if (!scene) updateLocation(id); }
function selectNode(id, reveal = false) {
  if (mapLoadStatus!=='ready'||!model || !visibleMap().nodes.has(id)) return;
  activePin=null;pinGroup=null;scene?.setActivePins([]);if(['pin','pins'].includes(panelKind))panelKind='issue';renderHeading();
  selectedId = id; scene?.setSelected(id); updateHash();
  if (reveal) openPanel('place'); else renderPanel();
}
function showPlaceHover(id, point) {
  const tip = byId('place-tooltip'); tip.replaceChildren(); tip.hidden = true;
  if (!model || !id || !point || matchMedia('(pointer:coarse)').matches) return;
  const node = visibleMap().nodes.get(id); if (!node) return;
  if(usesCurrentInventory())tip.append(element('strong','',node.path),element('p','',`${number(node.fileCount)} files · ${number(node.bytes)} bytes`),element('small','',summarizeRebuildGroup(comparison(),id)));
  else { const summary = summarizeStrataPlace(node, model.nodeState(id, frameIndex));
    tip.append(element('strong', '', node.name), element('p', '', summary.text), element('small', '', describeStrataActivity(model.activityFor(id, frameIndex)))); }
  const area = byId('project-map').getBoundingClientRect(); tip.hidden = false;
  tip.style.left = `${Math.max(8,Math.min(point.x+16,area.width-tip.offsetWidth-8))}px`; tip.style.top = `${Math.max(8,Math.min(point.y+16,area.height-tip.offsetHeight-8))}px`;
}
const sourceReader = createLatestProjectMapReader(async ({path,revision}, signal) => {
  const response = await fetch(`/api/project-strata/file?revision=${encodeURIComponent(revision)}&path=${encodeURIComponent(path)}`, {signal});
  const payload = await response.json(); if (!response.ok) throw new Error(payload.error || 'viewer-unavailable');
  if (payload.path !== path || payload.revision !== revision || typeof payload.content !== 'string') throw new Error('source-mismatch'); return payload;
});
function openOriginal(record) {
  if (!model || record.revision !== frame().revision || !model.fileAt(record.path,frameIndex)) return;
  sourceReader.cancel(); activeSource = null; byId('source-title').textContent = record.path; byId('source-retry').hidden = true;
  byId('source-status').textContent = `Git ${record.revision.slice(0,12)} · 原文`;
  byId('source-content').textContent = record.content || '（空の文書）'; openDialog('source-dialog');
}
async function loadFrameRecords() {
  if (mapLoadStatus!=='ready' || !model || !frame().recordResource) return;
  const selectedModel = model; const selectedFrame = frame();
  recordState = { revision: selectedFrame.revision, status: 'loading' }; renderRecordShortcuts(); renderPanel();
  const result = await recordLoader.request(selectedFrame);
  if (mapLoadStatus!=='ready' || result.status === 'stale' || model !== selectedModel || frame() !== selectedFrame) return;
  if (result.status === 'ready') applyFrameRecords(selectedFrame, result.value);
  recordState = { revision: selectedFrame.revision, status: result.status };
  records = buildMobileRecords(selectedFrame); renderHeading(); renderRecordShortcuts(); renderPanel();openPendingSearchRecord();
}
function openPendingSearchRecord(){
 if(mapLoadStatus!=='ready'||!pendingSearchRecord||pendingSearchRecord.revision!==frame().revision||recordState.status!=='ready')return;
 const record=['issue','sdd','adr'].flatMap(kind=>records[kind].records).find(record=>record.path===pendingSearchRecord.path);pendingSearchRecord=null;
 if(record)openOriginal(record);else notify('原文未収録');
}
function renderRecordLoading(container) {
  if (recordState.revision !== frame().revision || recordState.status === 'ready') return false;
  const status = element('p', 'coverage', recordState.status === 'error' ? '記録の取得に失敗' : '記録を読み込み中…');
  status.setAttribute('role', 'status'); container.append(status);
  if (recordState.status === 'error') {
    const retry = element('button', 'panel-action', '再試行'); retry.type = 'button';
    retry.addEventListener('click', () => void loadFrameRecords()); container.append(retry);
  }
  return true;
}
async function readSource(path = selectedId) {
  if (!model || !sourceAvailable || !model.fileAt(path,frameIndex)) return;
  const revision = frame().revision; activeSource = {path,revision}; byId('source-title').textContent = path;
  byId('source-status').textContent = `Git ${revision.slice(0,12)} の原文を読み込み中…`; byId('source-content').textContent = ''; byId('source-retry').hidden = true; openDialog('source-dialog');
  const result = await sourceReader.request({path,revision}); if (result.status === 'stale') return;
  if (result.status === 'error') { byId('source-status').textContent = '原文の取得に失敗'; byId('source-retry').hidden = false; return; }
  byId('source-status').textContent = `Git ${revision.slice(0,12)} · ${number(result.value.bytes)} bytes`; byId('source-content').textContent = result.value.content || '（空のファイル）';
}
function renderRecords(container, list) {
  for (const record of list) {
    const card = element('article','record-card'); card.append(element('p','record-change',({added:'＋ 追加',modified:'● 更新',unchanged:'変更なし',unknown:'比較未取得'})[record.change]),element('h3','',record.label),element('p','path',record.path));
    const open = element('button','','原文 ↗'); open.addEventListener('click',()=>openOriginal(record)); card.append(open); container.append(card);
  }
}
function renderPanel() {
  const content = byId('panel-content'); content.replaceChildren(); if (!model || !records) return;
  byId('data-scope').textContent = '';
  if (panelKind === 'place') { renderPlace(content); return; }
  if(panelKind==='pin'){renderPin(content);return;}
  if(panelKind==='pins'){
    byId('panel-title').textContent=usesCurrentInventory()?'差分':'ピン';
    if(comparisonStatus()!=='measured')content.append(element('p','coverage','未比較'));
    if(!usesCurrentInventory()&&(pinVisibility.offscreen||pinVisibility.unplaced))content.append(element('p','coverage',`画面外 ${pinVisibility.offscreen} · 位置未取得 ${pinVisibility.unplaced}`));
    for(const pin of pinGroup||pins){const button=element('button','pin-list-item');button.append(element('span','pin-kind',pin.kind==='change'?({added:'＋',modified:'●',deleted:'−',unknown:'?'})[pin.change]:pin.kind.toUpperCase()),element('span','',`${pin.path}${usesCurrentInventory()?(pin.change==='deleted'?' · 削除済み':pin.change==='unknown'?' · 未判定':''):pin.world?'':' · 位置未取得'}`));button.addEventListener('click',()=>choosePin(pin));content.append(button);}
    if(!pins.length&&comparisonStatus()==='measured')content.append(element('p','coverage','変更なし'));return;
  }
  byId('panel-title').textContent = ({issue:'Issue',sdd:'SDD',adr:'ADR'})[panelKind];
  const group = records[panelKind];
  if (renderRecordLoading(content)) return;
  if (panelKind === 'issue') {
    content.append(element('p','coverage',records.issue.basis==='unknown'?'Issue未取得':records.issue.basis==='same-revision-issue-title'?'保存版の題名':'保存版の抜粋'));
    if (frame().pr) content.append(element('p','place-summary',`PR #${frame().pr.number} · ${frame().pr.title}`));
  } else {
    content.append(element('p','coverage',group.status==='unknown'?'文書・比較未取得':group.status==='updated'?`前の表示版比：追加 ${group.changes.added.length} · 更新 ${group.changes.modified.length} · 削除 ${group.changes.deleted.length}`:'変更なし'));
  }
  if (!group.records.length) content.append(element('p','empty-record','関連原文未取得'));
  renderRecords(content, group.records);
  if (panelKind !== 'issue' && group.changedCount) {
    const details = element('details'); details.append(element('summary','','変更一覧'));
    for (const [kind, paths] of Object.entries(group.changes)) for (const path of paths) details.append(element('p','path',`${{added:'＋',modified:'●',deleted:'−'}[kind]} ${path}`)); content.append(details);
  }
  const coverage = records.coverage;
  content.append(element('p','coverage',`原文 ${coverage.selected} · 未収録 ${coverage.omitted} · 取得不可 ${coverage.unavailable} · 未確認 ${coverage.unexamined}`));
}
function renderPin(content) {
  const pin=activePin;if(!pin)return;byId('panel-title').textContent=pin.label;
  content.append(element('p','path',pin.path));
  if(usesCurrentInventory()&&pin.change==='deleted')content.append(element('p','coverage','削除済み · 現構成にはありません'));
  else if(!pin.world)content.append(element('p','coverage','位置未取得'));
  const node=model.map.nodes.get(pin.nodeId);
  if(node){content.append(element('h3','','役割（所属分類）'),element('p','place-summary',summarizeStrataPlace(node,model.nodeState(pin.nodeId,frameIndex)).text));}
  if(pin.kind==='change'){
    content.append(element('h3','','変更'),element('p','',pin.summary),element('p','coverage',`${pin.comparisonRevision.slice(0,7)} → ${pin.revision.slice(0,7)} · 前の表示版比`));
    if(pin.before&&pin.after)content.append(element('p','path',`${pin.before.objectId?.slice(0,7)||'—'} → ${pin.after.objectId?.slice(0,7)||'—'}`));
    content.append(element('p','coverage','意味差分：未取得'));
  }
  const actions=element('div','place-actions');
  const target=usesCurrentInventory()?changeMapTarget(pin,town(),town(frameIndex-1),comparisonMode):pin.world?{path:pin.nodeId,mode:comparisonMode}:null;
  if(target){const focus=element('button','panel-action',target.mode!==comparisonMode?`${target.mode==='before'?'前':'後'}の地図で表示`:'地図で表示');focus.addEventListener('click',()=>{if(target.mode!==comparisonMode)changeComparison(target.mode);selectedId=target.path;scene?.setSelected(selectedId);updateHash();scene?.focus(target.path);setSheet(false);});actions.append(focus);}
  if(pin.record){const original=element('button','panel-action','原文');original.addEventListener('click',()=>openOriginal(pin.record));actions.append(original);}
  else if(sourceAvailable&&pin.after){const original=element('button','panel-action','コード');original.addEventListener('click',()=>readSource(pin.path));actions.append(original);}
  content.append(actions);
  if (pin.kind === 'change' && !renderRecordLoading(content)) renderChangeTrace(content, { frame: frame(), path: pin.path, openOriginal });
}
function renderPlace(content) {
  if(usesCurrentInventory()){
    const map=visibleMap(), node=map.nodes.get(selectedId)||map.root;byId('panel-title').textContent=node.name;
    renderRebuildPlace(content,{town:town(),beforeTown:town(frameIndex-1),comparison:comparison(),path:node.path,mode:comparisonMode,beforeFrame:model.frames[frameIndex-1],afterFrame:frame(),navigate,
      chooseChange:path=>{const pin=pins.find(candidate=>candidate.path===path);if(pin)choosePin(pin);},focus:id=>{scene?.focus(id);setSheet(false);}});return;
  }
  const node = model.map.nodes.get(selectedId); if (!node) return;
  const state = model.nodeState(selectedId,frameIndex); byId('panel-title').textContent = node.name;
  content.append(element('p','path',node.path || 'プロジェクト全体'),element('p','place-summary',summarizeStrataPlace(node,state).text),element('p','coverage',describeStrataActivity(model.activityFor(node.id,frameIndex))));
  if (!state.presentFiles) content.append(element('p','empty-record',state.presence==='absent-after-observation'?'削除済み':'未出現'));
  const actions = element('div','place-actions');
  const enter = element('button','panel-action','ズーム'); enter.addEventListener('click',()=>{scene?.focus(node.id);setSheet(false);}); actions.append(enter);
  if (sourceAvailable && node.type==='file' && state.file) { const read = element('button','panel-action','コード原文'); read.addEventListener('click',()=>readSource()); actions.append(read); } content.append(actions);
  if (node.type === 'file') {
    const change = pins.find(pin => pin.path === node.path);
    if (change) { const related = element('button', 'panel-action', '変更・記録'); related.addEventListener('click', () => choosePin(change)); content.append(related); }
  }
  const label = element('label','coverage','ファイル'); label.htmlFor = 'file-search'; const input = element('input','place-search'); input.id = 'file-search'; input.type = 'search'; input.placeholder = 'ファイル名'; input.autocomplete = 'off';
  const results = element('div'); results.id = 'search-results'; content.append(label,input,results);
  function renderList() {
    results.replaceChildren(); const query = input.value.trim().toLowerCase();
    const children = query ? model.map.orderedNodes.filter(child=>child.firstObserved<=frameIndex && child.path.toLowerCase().includes(query)) : node.children.map(id=>model.map.nodes.get(id)).filter(child=>child.firstObserved<=frameIndex);
    for (const child of children.slice(0,60)) { const button=element('button','child'); const dot=element('span','dot'); dot.style.backgroundColor=colorForMapPalette(child,{activity:model.activityFor(child.id,frameIndex),state:model.nodeState(child.id,frameIndex)},paletteId).css; const present=model.nodeState(child.id,frameIndex).presentFiles; button.append(dot,element('span','name',query?child.path:child.name),element('span','count',present?child.type==='folder'?`${present} ↗`:'↗':'不在'));button.addEventListener('click',()=>navigate(child.id));results.append(button); }
    if (!children.length) results.append(element('p','coverage','該当なし')); else if (children.length>60) results.append(element('p','coverage',`表示 60 / ${children.length}件`));
  }
  input.addEventListener('input',renderList); renderList();
}
function renderRecordShortcuts() {
  const current = frame();
  for (const key of ['sdd','adr']) {
    const group = records[key]; const status = byId(`${key}-status`);
    const pending = recordState.revision === current.revision && recordState.status !== 'ready';
    status.textContent = pending ? recordState.status === 'error' ? '取得失敗' : '読込中…'
      : group.status === 'updated' ? `● ${group.changedCount}件の変化` : group.status === 'unchanged' ? '変更なし' : current.changes.status !== 'measured' ? '比較不明' : '関連未取得';
    status.classList.toggle('updated', !pending && group.status === 'updated');
  }
}
function renderFrame() {
  const current=frame(); records=buildMobileRecords(current);
  recordState = { revision: current.revision, status: current.recordResource ? 'loading' : 'ready' };
  byId('previous').disabled=frameIndex===0; byId('next').disabled=frameIndex===model.frames.length-1;
  byId('pr-chip').querySelector('span').textContent = current.pr ? 'PR' : 'Git';
  byId('pr-value').textContent=current.pr?`#${current.pr.number}`:frameIndex===0?'はじまり':current.revision.slice(0,7); byId('frame-count').textContent=`${frameIndex+1} / ${model.frames.length}`;
  byId('picker-dialog').querySelector('h2').textContent = '版';
  byId('previous').setAttribute('aria-label', '前の版へ'); byId('next').setAttribute('aria-label', '次の版へ');
  byId('snapshot').textContent=`${current.revision.slice(0,7)} · ${number(current.files.length)} files`;
  byId('frame-date').textContent=new Date(current.date).toLocaleDateString('ja-JP',{month:'2-digit',day:'2-digit'});
  refreshViewControls();
  pins=usesCurrentInventory()?buildRebuildPins(town(),comparison()):buildMapPins(model,frameIndex);scene?.setPins(pins);byId('pins-count').textContent=formatComparisonCount(comparisonStatus(),pins.length);renderHeading();
  renderRecordShortcuts();
  renderHistoryData();
  for (const [index,button] of [...byId('milestones').children].entries()) button.setAttribute('aria-current',String(index===frameIndex));
  renderPanel();
}
function renderHistoryData() {
  const current=frame();
  const data=byId('history-data');data.replaceChildren();
  const mapDetails=usesCurrentInventory()?[['表示地図',visibleMap().id],['表現',viewMode.startsWith('library')?'1ファイル1冊 · 塔は蔵書数/種類':'現ファイル数 · 対数上限付き'],['色','所属分類'],['差分','前の表示版との2inventory比較']]:[['地図',current.mapSnapshot.mapDigest],['活動色','内容編集 0 / 2 / 8回以上'],['集計','第1親差分 · 初出除外 · 配下平均']];
  for(const [label,value] of [['PR',current.pr?`#${current.pr.number}`:frameIndex===0?'はじまり':'PR外のmain'],['Git',current.revision],['取得',new Date(model.fetchedAt).toLocaleString('ja-JP')],['範囲',`main · ${model.frames.length}時点`],['配色','ColorBrewer Set3'],...mapDetails])data.append(element('dt','',label),element('dd','',value));
}
function changeFrame(index,{save=true,automatic=false}={}) {
  if (mapLoadStatus!=='ready'||!model || !Number.isInteger(index) || index<0 || index>=model.frames.length) return;
  if(!automatic)stopJourney();pendingSearchRecord=null;
  recordLoader.cancel(); releaseFrameRecords(frame());
  frameIndex=index;activePin=null;pinGroup=null;if(['pin','pins'].includes(panelKind))panelKind='issue'; sourceReader.cancel(); activeSource=null; byId('source-dialog').close(); showPlaceHover(null);
  if(frameIndex===0)comparisonMode='after';else if(automatic)comparisonMode='diff';
  if(usesCurrentInventory()&&!visibleMap().nodes.has(selectedId)){selectedId='';panelKind='issue';}
  scene?.setFrame(index); renderFrame(); if(save) updateHash(); void loadFrameRecords();
}
function refreshViewControls() {
  byId('view-value').textContent=({library:`書架 ${libraryProjection}`,'library-flat':'書架 2D',rebuild:'建築',strata:'地層'})[viewMode];
  document.body.dataset.view=viewMode;
  byId('comparison-bar').hidden=!usesCurrentInventory();
  byId('pins-label').textContent=usesCurrentInventory()?'差分':'ピン';
  byId('comparison-label').textContent=comparisonMode==='before'?revisionLabel(model.frames[frameIndex-1]):comparisonMode==='after'?revisionLabel(frame()):`${revisionLabel(model.frames[frameIndex-1])} → ${revisionLabel(frame())}`;
  for(const button of document.querySelectorAll('[data-comparison]')){button.setAttribute('aria-pressed',String(button.dataset.comparison===comparisonMode));button.disabled=frameIndex===0&&button.dataset.comparison!=='after';}
  scene?.setComparisonMode?.(comparisonMode);
}
function changeComparison(mode) {
  if(mapLoadStatus!=='ready'||!model || !['before','diff','after'].includes(mode) || frameIndex===0&&mode!=='after')return;
  comparisonMode=mode;activePin=null;pinGroup=null;scene?.setActivePins([]);
  if(!visibleMap().nodes.has(selectedId))selectedId='';
  if(['pin','pins'].includes(panelKind))panelKind='issue';
  refreshViewControls();scene?.setSelected(selectedId);renderHistoryData();renderHeading();renderPanel();updateHash();
}
async function mountScene() {
  const ticket=++sceneTicket, currentModel=model;scene?.dispose();scene=undefined;
  const createScene=viewMode==='library'?(await import('./library-orbit-scene.mjs')).createLibraryOrbitScene:viewMode==='library-flat'?(await import('./library-scene.mjs')).createLibraryScene:viewMode==='rebuild'?(await import('./rebuild-scene.mjs')).createRebuildScene:(await import('./flat-scene.mjs')).createFlatScene;
  if(ticket!==sceneTicket||model!==currentModel)return;
  const renewCanvas=()=>{
    const previous=byId('project-map'), next=previous.cloneNode(false);
    // A canvas cannot change context type after 2D or WebGL has been acquired.
    layoutObserver.unobserve(previous);previous.replaceWith(next);layoutObserver.observe(next);
    next.classList.remove('library-canvas','library-orbit-canvas');
    next.setAttribute('aria-label',viewMode==='library'?'円形図書館。ドラッグで中央を周回、上下で角度、ピンチで距離を変更。矢印キーで周回、＋−キーで距離。':'システムの地図。ドラッグで移動、ピンチまたは＋−キーで拡大縮小。');
    return next;
  };
  const options={model,initialFrameIndex:frameIndex,onSelect:id=>selectNode(id,true),onNavigate:id=>selectNode(id,true),onPinSelect:choosePin,onHover:showPlaceHover,onChange:state=>{if(ticket!==sceneTicket||mapLoadStatus!=='ready')return;if(state.pins)pinVisibility=state.pins;updateLocation(state.regionId);byId('scale').textContent=`${state.zoom.toFixed(1)}×`;},onError:()=>{if(ticket!==sceneTicket||model!==currentModel)return;showMapLoadState('drawing-failed');byId('loading').hidden=false;byId('loading-text').textContent='地図の描画に失敗';byId('retry').hidden=false;}};
  libraryProjection='3D';
  try { scene=createScene({...options,canvas:renewCanvas()}); }
  catch(error){
    if(viewMode!=='library'||error.message!=='library-webgl-unavailable')throw error;
    const fallback=await import('./library-scene.mjs');
    if(ticket!==sceneTicket||model!==currentModel)return;
    scene=fallback.createLibraryScene({...options,canvas:renewCanvas()});libraryProjection='2D';
    byId('project-map').setAttribute('aria-label','書架 2D。ドラッグで移動、ピンチで拡大縮小。');
  }
  if(ticket!==sceneTicket||model!==currentModel){scene?.dispose();scene=undefined;return;}
  scene.setPalette(paletteId);scene.setPins(pins);scene.setComparisonMode?.(comparisonMode);refreshPinViewport();if(selectedId&&visibleMap().nodes.has(selectedId))scene.focus(selectedId);byId('loading').hidden=true;
}
async function load() {
  pendingSearchRecord=null;historySearch.close();showMapLoadState('loading');
  recordLoader.clear(); recordState = { revision: null, status: 'ready' };
  const ticket=++loadTicket; ++sceneTicket; towns=new Map();comparisons=new Map();sourceReader.cancel(); scene?.dispose(); scene=undefined; model=undefined; records=undefined; selectedId='';activePin=null;pinGroup=null;pins=[];panelKind='issue';pinVisibility={offscreen:0,unplaced:0}; byId('source-dialog').close(); showPlaceHover(null);
  byId('loading').hidden=false; byId('retry').hidden=true; byId('open-saved-maps').hidden=true;byId('loading-text').textContent='読込中…';
  for (const id of ['previous','next','pr-chip','place-chip']) byId(id).disabled=true;
  byId('issue-summary-text').textContent='読み込み中…';byId('panel-content').replaceChildren();
  try {
    const response=await fetch(historyEndpoint);if(!response.ok)throw new Error('history-unavailable'); const payload=await response.json();if(ticket!==loadTicket)return;
    if(payload.ancestry)await verifyAncestralHistory(payload);else await verifyHistoryMapSnapshots(payload);if(ticket!==loadTicket)return;
    model=buildStrataModel(payload,{requireSavedMaps:true});const params=new URLSearchParams(location.hash.slice(1));
    frameIndex=params.get('revision')?resolveJourneyFrame(model.frames,params.get('revision')):model.frames.length-1;
    viewMode=['strata','rebuild','library-flat'].includes(params.get('view'))?params.get('view'):'library';comparisonMode=frameIndex===0?'after':['before','after'].includes(params.get('compare'))?params.get('compare'):'diff';
    selectedId=visibleMap().nodes.has(params.get('path'))?params.get('path'):'';
    const milestones=byId('milestones');milestones.replaceChildren();
    for(const [index,current] of model.frames.entries()){
      const label = index === 0 ? 'はじまり · プロジェクトの起点' : current.pr ? `PR #${current.pr.number} · ${current.pr.title}` : `Git ${current.revision.slice(0,7)}`;
      const button=element('button','',label);button.addEventListener('click',()=>{changeFrame(index);byId('picker-dialog').close();});milestones.append(button);
    }
    renderFrame();updateLocation('');updateHash();showMapLoadState('loading');
    try {
      await mountScene();if(ticket!==loadTicket||mapLoadStatus==='drawing-failed')return;renderFrame();updateLocation('');showMapLoadState('ready');
      requestAnimationFrame(() => { if (ticket === loadTicket) void loadFrameRecords(); });
    } catch { if(ticket!==loadTicket)return;showMapLoadState('drawing-failed');byId('loading').hidden=false;byId('loading-text').textContent='地図の描画に失敗';byId('retry').hidden=false; }
  } catch(error){if(ticket!==loadTicket)return;showMapLoadState('failed');scene?.dispose();scene=undefined;model=undefined;records=undefined;byId('loading-text').textContent='地図の照合に失敗';if(/^(?:project-|history-)[a-z-]+$/.test(error.message))byId('loading-text').textContent+=` (${error.message})`;byId('retry').hidden=false;byId('open-saved-maps').hidden=false;byId('issue-summary-text').textContent='記録未取得';}
}
byId('previous').addEventListener('click',()=>changeFrame(frameIndex-1));byId('next').addEventListener('click',()=>changeFrame(frameIndex+1));
byId('pr-chip').addEventListener('click',()=>openDialog('picker-dialog'));byId('place-chip').addEventListener('click',()=>openPanel('place'));
byId('issue-summary').addEventListener('click',()=>{if(activePin){openPanel('pin');return;}if(panelKind==='pins'){openPanel('pins');return;}if(panelKind==='place'&&usesCurrentInventory()){openPanel('place');return;}if(records?.issue.records.length===1)openOriginal(records.issue.records[0]);else openPanel('issue');});
byId('view-chip').addEventListener('click',async()=>{if(!model)return;const ticket=loadTicket,currentModel=model;pendingSearchRecord=null;viewMode=({library:'library-flat','library-flat':'rebuild',rebuild:'strata',strata:'library'})[viewMode];activePin=null;pinGroup=null;selectedId='';panelKind='issue';byId('loading').hidden=false;byId('loading-text').textContent='読込中…';renderFrame();updateHash();showMapLoadState('loading');try{await mountScene();if(ticket!==loadTicket||model!==currentModel||mapLoadStatus==='drawing-failed')return;renderFrame();showMapLoadState('ready');void loadFrameRecords();}catch{if(ticket!==loadTicket||model!==currentModel)return;showMapLoadState('drawing-failed');byId('loading').hidden=false;byId('loading-text').textContent='地図の描画に失敗';byId('retry').hidden=false;}});
for(const button of document.querySelectorAll('[data-comparison]'))button.addEventListener('click',()=>changeComparison(button.dataset.comparison));
byId('return-issue').addEventListener('click',restoreIssue);
byId('pins-chip').addEventListener('click',()=>{activePin=null;pinGroup=null;scene?.setActivePins([]);panelKind='pins';renderHeading();openPanel('pins');});
byId('sdd-tab').addEventListener('click',()=>openPanel('sdd'));byId('adr-tab').addEventListener('click',()=>openPanel('adr'));
byId('collapse-sheet').addEventListener('click',()=>{setSheet(false);byId('sheet-handle').focus();});
const handle=byId('sheet-handle');
handle.addEventListener('click',()=>{if(suppressHandleClick){suppressHandleClick=false;return;}setSheet(!sheetExpanded);});
handle.addEventListener('keydown',event=>{if(event.key==='ArrowUp'||event.key==='ArrowDown'){event.preventDefault();setSheet(event.key==='ArrowUp');}});
handle.addEventListener('pointerdown',event=>{if(event.button!==0)return;sheetDrag={id:event.pointerId,y:event.clientY,height:sheet.getBoundingClientRect().height,moved:false};handle.setPointerCapture(event.pointerId);});
handle.addEventListener('pointermove',event=>{if(!sheetDrag||sheetDrag.id!==event.pointerId)return;const dy=sheetDrag.y-event.clientY;if(Math.abs(dy)>8)sheetDrag.moved=true;if(!sheetDrag.moved)return;const {peek,max}=sheetLimits();sheet.dataset.dragging='true';sheet.style.height=`${Math.max(peek,Math.min(max,sheetDrag.height+dy))}px`;byId('sheet-body').inert=false;});
handle.addEventListener('pointerup',event=>{if(!sheetDrag||sheetDrag.id!==event.pointerId)return;const drag=sheetDrag;sheetDrag=null;if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);if(drag.moved){suppressHandleClick=true;setSheet(drag.y-event.clientY>0);}});
handle.addEventListener('pointercancel',()=>{sheetDrag=null;suppressHandleClick=false;setSheet(sheetExpanded);});
new ResizeObserver(()=>{if(!sheetDrag)setSheet(sheetExpanded);}).observe(byId('sheet-top'));
function refreshPinViewport(){
  const area=byId('project-map').getBoundingClientRect(), panel=sheet.getBoundingClientRect();
  const header=document.querySelector('.map-header').getBoundingClientRect();
  const desktop=innerWidth>=800, left=desktop?panel.right+12:12, right=innerWidth-60;
  const top=panel.top-56;
  for(const [id,x] of [['previous',left],['next',right]]){
    const button=byId(id);button.style.left=x+'px';button.style.top=top+'px';
  }
  const bottom=desktop?area.bottom-30:panel.top-72;
  scene?.setPinViewport({left:(desktop?panel.right+24:30)-area.left,top:header.bottom+24-area.top,right:area.width-30,bottom:Math.max(header.bottom+24,bottom)-area.top});
  byId('map-bottom').style.bottom=(desktop?20:innerHeight-panel.top+10)+'px';
}
const layoutObserver=new ResizeObserver(refreshPinViewport);
layoutObserver.observe(byId('project-map'));layoutObserver.observe(sheet);layoutObserver.observe(document.querySelector('.map-header'));
addEventListener('resize',()=>{if(!sheetDrag)setSheet(sheetExpanded);});
const historySearch=createHistorySearch({dialog:byId('history-search-dialog'),readFrames:()=>model?.frames||[],onChoose:({frameIndex:index,path,kind,comparisonMode:mode})=>{if(!model)return;changeFrame(index);if(usesCurrentInventory()&&mode)changeComparison(mode);if(kind==='record'){pendingSearchRecord={revision:frame().revision,path};openPanel(path.startsWith('docs/decisions/')?'adr':path.startsWith('docs/issues/')?'issue':'sdd');openPendingSearchRecord();}else if(path&&visibleMap().nodes.has(path)){navigate(path);}else{openPanel('issue');}}});
byId('question-search').addEventListener('click',()=>{stopJourney();historySearch.open();});
byId('journey-play').addEventListener('click',()=>{if(!model)return;if(journeyTimer){stopJourney();return;}if(frameIndex===model.frames.length-1)changeFrame(0);byId('journey-play').textContent='Ⅱ';byId('journey-play').setAttribute('aria-label','履歴を停止');byId('journey-play').setAttribute('aria-pressed','true');journeyTimer=setInterval(()=>{if(frameIndex>=model.frames.length-1){stopJourney();return;}changeFrame(frameIndex+1,{automatic:true});},2600);});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopJourney();});
byId('account').addEventListener('click',()=>notify('準備中'));
byId('project-chip').addEventListener('click',()=>openDialog('data-dialog'));
byId('project-home').addEventListener('click',()=>{if(model){selectNode('');scene?.home();updateLocation('');}});
byId('map-info').addEventListener('click',()=>openDialog('data-dialog'));
for(const button of document.querySelectorAll('[data-close]'))button.addEventListener('click',()=>byId(button.dataset.close).close());
byId('source-dialog').addEventListener('close',()=>sourceReader.cancel());byId('source-retry').addEventListener('click',()=>{if(activeSource?.revision===frame()?.revision)readSource(activeSource.path);});
byId('retry').addEventListener('click',load);addEventListener('hashchange',load);load();
