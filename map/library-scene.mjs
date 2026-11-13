import { compareRevisionTrees } from './rebuild-model.mjs';
import { buildRevisionLibrary, libraryNodeContainsPoint } from './library-model.mjs';
import { createMapPointerGesture } from './strata-interaction.mjs';
import { colorForMapPalette, defaultMapPaletteId, normalizeMapPaletteId } from './map-palette.mjs';
import { containsPoint } from './model.mjs';
import { normalizeFlatViewport, fitFlatCamera, projectFlatPoint, unprojectFlatPoint, panFlatCamera, zoomFlatCamera,
  reframeFlatViewport, flatViewportCenter, isFlatViewportUsable } from './flat-camera.mjs';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const paper = '#FFFEFB';
const ink = '#354957';
const sameBounds = (first, second) => ['left', 'top', 'right', 'bottom'].every(key => first[key] === second[key]);
const boxFor = node => {
  const bounds = node.id === '' && node.hubBounds ? node.hubBounds : node.bounds;
  return { x: bounds.minX ?? bounds.x ?? node.x, y: bounds.minY ?? bounds.y ?? node.y,
    width: bounds.width ?? node.width, height: bounds.height ?? node.height };
};
const boxPolygon = box => [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y },
  { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }];
const boxCenter = box => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const overlaps = (first, second) => first.x < second.x + second.width + 4 && first.x + first.width + 4 > second.x
  && first.y < second.y + second.height + 4 && first.y + first.height + 4 > second.y;
function blend(hex, towards, fraction) {
  return `#${[1, 3, 5].map(offset => Math.round(parseInt(hex.slice(offset, offset + 2), 16) * (1 - fraction)
    + parseInt(towards.slice(offset, offset + 2), 16) * fraction).toString(16).padStart(2, '0')).join('')}`;
}
function nearestFolder(town, path) {
  let candidate = path.split('/').slice(0, -1).join('/');
  while (candidate && town.nodes.get(candidate)?.type !== 'folder') candidate = candidate.split('/').slice(0, -1).join('/');
  return candidate;
}

export function createLibraryScene({ canvas, model, initialFrameIndex = 0, onSelect = () => {}, onNavigate = () => {},
  onHover = () => {}, onChange = () => {}, onError = () => {} }) {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context || !model?.frames?.length) throw new Error('library-scene-unavailable');
  const surface = canvas.parentElement; const listeners = []; const townCache = new Map();
  const labels = new Map(); const labelHost = document.createElement('div'); labelHost.className = 'library-labels';
  surface.append(labelHost); canvas.classList.add('library-canvas');
  const gesture = createMapPointerGesture({ rotate: false, tilt: false, coalesce: true });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let frameIndex = initialFrameIndex; let comparisonMode = 'diff'; let paletteId = defaultMapPaletteId;
  let town; let comparison; let visualNodes = []; let deletionOwners = new Map(); let changesByPath = new Map();
  let selectedId = null; let hoveredId = null; let activePinPaths = new Set(); let pins = [];
  let width = 1; let height = 1; let ratio = 1; let camera; let referenceScale; let referenceViewport;
  let viewportCalibrated = false; let hasExternalViewport = false; let cameraTouched = false;
  let resizedViewport = false; let requestedViewport = null;
  let animation = null; let deferredFocus = null; let instantFocus = null; let focusedId = '';
  let renderRequest = null; let disposed = false; let lastState = '';

  function cachedTown(index) {
    if (!townCache.has(index)) townCache.set(index, buildRevisionLibrary(model.frames[index]));
    return townCache.get(index);
  }
  function requestDraw() { if (!disposed && renderRequest === null) renderRequest = requestAnimationFrame(draw); }
  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options); listeners.push(() => target.removeEventListener(event, callback, options));
  }
  function updateTown() {
    const before = frameIndex > 0 ? model.frames[frameIndex - 1] : null; const after = model.frames[frameIndex];
    comparison = compareRevisionTrees(before, after);
    town = cachedTown(comparisonMode === 'before' && before ? frameIndex - 1 : frameIndex);
    changesByPath = new Map(comparison.changes.map(change => [change.path, change])); deletionOwners = new Map();
    if (comparisonMode === 'diff' && comparison.status === 'measured') for (const change of comparison.changes) {
      if (change.status !== 'deleted') continue;
      const owner = nearestFolder(town, change.path); deletionOwners.set(owner, (deletionOwners.get(owner) ?? 0) + 1);
    }
    if (selectedId !== null && !town.nodes.has(selectedId)) selectedId = null;
    setHovered(null); requestDraw();
  }
  function nodeColor(node) {
    return colorForMapPalette(node, { activity: 2, state: { presentFiles: node.fileCount || 1 } }, paletteId).hex;
  }
  function roundBox(box, radius = 8) {
    context.beginPath(); context.roundRect(box.x, box.y, box.width, box.height, Math.max(0, Math.min(radius, box.width / 2, box.height / 2)));
  }
  function fillBox(box, fill, stroke, lineWidth = 1, radius = 8) {
    roundBox(box, radius); context.fillStyle = fill; context.fill();
    if (stroke) { context.strokeStyle = stroke; context.lineWidth = lineWidth; context.stroke(); }
  }
  function line(from, to, color, size) {
    context.beginPath(); context.moveTo(from.x, from.y); context.lineTo(to.x, to.y);
    context.strokeStyle = color; context.lineWidth = size; context.lineCap = 'round'; context.stroke();
  }
  function isVisible(box) {
    const point = projectFlatPoint(camera, box);
    return point.x < width + 30 && point.y < height + 30 && point.x + box.width * camera.scale > -30 && point.y + box.height * camera.scale > -30;
  }
  function collectVisuals() {
    const visible = [];
    for(const node of town.orderedNodes){
      const box=boxFor(node);if(node.id&&!isVisible(box))continue;
      const expanded=node.type==='folder'&&Math.min(box.width,box.height)*camera.scale>150;
      visible.push({node,box,expanded,color:nodeColor(node)});
    }
    return visible;
  }
  function visibleChange(node, expanded = false) {
    if (comparisonMode !== 'diff' || comparison.status !== 'measured') return null;
    const group = comparison.groups.get(node.id);
    const unknown=(comparison.unexplainedGitChanges || []).filter(path=>!node.id||path===node.id||path.startsWith(`${node.id}/`)).length;
    if (node.type === 'folder') {
      const added = group?.added ?? 0, modified = group?.modified ?? 0;
      const deleted = node.id === '' ? comparison.totals.deleted : expanded ? deletionOwners.get(node.id) ?? 0 : group?.deleted ?? 0;
      return added || modified || deleted || unknown ? { added, modified, deleted, unknown } : null;
    }
    const change = changesByPath.get(node.id);
    return change ? { added: Number(change.status === 'added'), modified: Number(change.status === 'modified'), deleted: 0, unknown } : unknown ? {added:0,modified:0,deleted:0,unknown} : null;
  }
  function changeText(changes) {
    return [['+', changes?.added], ['~', changes?.modified], ['−', changes?.deleted], ['?',changes?.unknown]].filter(([, count]) => count > 0).map(([symbol, count]) => `${symbol}${count}`).join(' ');
  }
  function tracePolygon(polygon) {
    context.beginPath();polygon.forEach((point,index)=>index?context.lineTo(point.x,point.y):context.moveTo(point.x,point.y));context.closePath();
  }
  function traceShelf(shelf, padding = 0) {
    context.beginPath();context.arc(0,0,shelf.outerRadius+padding,shelf.startAngle,shelf.endAngle);
    context.arc(0,0,Math.max(1,shelf.innerRadius-padding),shelf.endAngle,shelf.startAngle,true);context.closePath();
  }
  function ellipse(x,y,radiusX,radiusY,fill,stroke=null,lineWidth=1) {
    context.beginPath();context.ellipse(x,y,radiusX,radiusY,0,0,Math.PI*2);context.fillStyle=fill;context.fill();
    if(stroke){context.strokeStyle=stroke;context.lineWidth=lineWidth;context.stroke();}
  }
  function drawTower() {
    const colors=town.landmarks.map(node=>nodeColor(node));if(!colors.length)colors.push('#BEBADA','#8DD3C7');
    ellipse(0,40,83,29,'#3349570B');ellipse(0,31,77,29,'#E7E5DC');ellipse(0,24,77,29,'#FFFFFF','#DADDD5',1);
    for(let index=0;index<town.tower.kinds.length;index++){
      const angle=Math.PI*.15+index*Math.PI*.7/Math.max(1,town.tower.kinds.length-1);
      ellipse(Math.cos(angle)*66,Math.sin(angle)*23+24,3.5,2.2,colors[index%colors.length]);
    }
    for(let index=0;index<town.tower.levels;index++){
      const y=17-index*14,radius=56-index*4.1,color=colors[index%colors.length];
      context.fillStyle='#ECECE6';context.fillRect(-radius,y-15,radius*2,17);
      ellipse(0,y+2,radius,12,blend(color,ink,.12));
      context.fillStyle=blend(color,paper,.45);context.fillRect(-radius,y-10,radius*2,11);
      ellipse(0,y-10,radius,12,'#FFFFFF',blend(color,ink,.08),1);
      ellipse(0,y-10,radius*.68,8,blend(color,paper,.45));
      ellipse(0,y-11,radius*.29,4,color);
      for(let detail=0;detail<3;detail++){
        const x=(detail-1)*radius*.52;
        fillBox({x:x-3.4,y:y-7,width:6.8,height:8},color,null,0,2);
      }
    }
    const top=8-town.tower.levels*14;
    ellipse(0,top+8,19,6,'#D6DAD5');ellipse(0,top,16,16,colors[0],'#FFFFFF',3);
    ellipse(-4,top-5,4,5,'#FFFFFFA8');
    context.save();context.translate(0,top-23);context.rotate(Math.PI/4);
    fillBox({x:-6,y:-6,width:12,height:12},'#FDB462','#FFFFFF',2,2);context.restore();
    const ornamentCount=town.tower.ornaments;
    for(let index=0;index<ornamentCount;index++){
      const angle=index*Math.PI*2/Math.max(1,ornamentCount),x=Math.cos(angle)*102,y=Math.sin(angle)*48+12;
      ellipse(x,y+5,6,3,'#4555670A');ellipse(x,y,4.5,4.5,colors[index%colors.length],'#FFFFFF',1.4);
    }
    for(const direction of [-1,1]){
      context.save();context.translate(direction*54,top+34);context.scale(direction,1);
      for(let page=0;page<4;page++){
        context.beginPath();context.moveTo(0,7);context.quadraticCurveTo(26,-13-page*6,47+page*4,-4-page*7);
        context.lineTo(40+page*4,3-page*7);context.quadraticCurveTo(19,0,0,7);context.closePath();
        context.fillStyle=page%2?'#FFFFFF':blend(colors[page%colors.length],paper,.65);context.fill();context.strokeStyle='#D8DFDD';context.lineWidth=.8;context.stroke();
      }context.restore();
    }
  }
  function drawBook(entry) {
    const {node,color}=entry,polygon=node.polygon;
    tracePolygon(polygon);context.fillStyle=color;context.fill();context.strokeStyle=blend(color,ink,.12);context.lineWidth=.45;context.stroke();
    const book=node.book,angle=(book.startAngle+book.endAngle)/2;
    const projectedWidth=(book.endAngle-book.startAngle)*book.innerRadius*camera.scale;
    if(projectedWidth>2.4){
      const inner={x:Math.cos(angle)*(book.innerRadius+4),y:Math.sin(angle)*(book.innerRadius+4)};
      const outer={x:Math.cos(angle)*(book.outerRadius-3),y:Math.sin(angle)*(book.outerRadius-3)};
      line(inner,outer,'#FFFFFF9C',Math.min(1.7,2/camera.scale));
    }
    const changes=visibleChange(node);
    const selected=node.id===selectedId||node.id===hoveredId||activePinPaths.has(node.id);
    if(changes||selected){
      tracePolygon(polygon);context.strokeStyle=selected?'#304F60':'#70604A';context.lineWidth=(selected?2.6:1.3)/camera.scale;context.stroke();
      if(changes?.added){const point=node.center;ellipse(point.x,point.y,2.5/camera.scale,2.5/camera.scale,'#FFFFFF','#405B4B',1/camera.scale);}
    }
  }
  function drawMap() {
    context.setTransform(ratio,0,0,ratio,0,0);context.clearRect(0,0,width,height);
    context.fillStyle=paper;context.fillRect(0,0,width,height);
    const origin=projectFlatPoint(camera,{x:0,y:0});
    context.setTransform(camera.scale*ratio,0,0,camera.scale*ratio,origin.x*ratio,origin.y*ratio);
    context.setLineDash([]);
    const allRadii=new Set(town.sectors.flatMap(sector=>sector.rows.map(row=>row.innerRadius-8)));
    context.strokeStyle='#E3E5DE';context.lineWidth=.8/camera.scale;
    for(const radius of allRadii){context.beginPath();context.arc(0,0,radius,0,Math.PI*2);context.stroke();}
    context.beginPath();context.arc(0,0,town.outerRadius+14,0,Math.PI*2);context.setLineDash([2/camera.scale,7/camera.scale]);context.stroke();context.setLineDash([]);
    for(const sector of town.sectors){
      const color=sector.path?nodeColor(town.nodes.get(sector.path)):'#BEBADA';
      for(const shelf of sector.rows){
        context.save();context.translate(0,4);traceShelf(shelf,2);context.fillStyle='#35495713';context.fill();context.restore();
        traceShelf(shelf,2);context.fillStyle='#FFFFFF';context.fill();context.strokeStyle=blend(color,paper,.35);context.lineWidth=1.4;context.stroke();
        context.beginPath();context.arc(0,0,shelf.outerRadius+2,shelf.startAngle,shelf.endAngle);context.strokeStyle=blend(color,ink,.08);context.lineWidth=3.4;context.stroke();
      }
    }
    for(const entry of visualNodes)if(entry.node.type==='file')drawBook(entry);
    for(const entry of visualNodes){
      const {node}=entry;if(node.type!=='folder'||!node.id)continue;
      if(node.id!==selectedId&&node.id!==hoveredId)continue;
      for(const polygon of node.polygons){tracePolygon(polygon);context.strokeStyle='#36586B';context.lineWidth=2.4/camera.scale;context.stroke();}
    }
    drawTower();
  }
  function paintLabels() {
    const visible = new Set(); const occupied = []; const viewport = camera.viewport;
    if (isFlatViewportUsable(viewport)) for (const entry of visualNodes) {
      const { node, box, expanded } = entry;
      const projectedWidth = box.width * camera.scale; const projectedHeight = box.height * camera.scale;
      if (node.type === 'file' && (projectedWidth < 40 || projectedHeight < 24)) continue;
      if(node.type==='folder'&&node.parentId&&((camera.scale/referenceScale)<1.7||projectedWidth<95||projectedHeight<38))continue;
      const changes = visibleChange(node, expanded); const badge = changeText(changes);
      const name = node.id === '' ? 'XOZU' : node.name;
      const sector=node.id&&node.parentId===''?town.sectors.find(sector=>sector.path===node.id):null;
      const angle=sector?(sector.startAngle+sector.endAngle)/2:0;
      const anchor=node.id===''?{x:0,y:72}:sector?{x:Math.cos(angle)*(sector.outerRadius+18),y:Math.sin(angle)*(sector.outerRadius+18)}:node.center;
      const point = projectFlatPoint(camera, anchor);
      const labelWidth = Math.min(node.type === 'file' ? Math.max(60,projectedWidth-4) : 130, Math.max(48, name.length * 6.8 + 16, badge.length * 6 + 12));
      const labelHeight = badge ? 40 : 26;
      const rect = { x:point.x-labelWidth/2,y:point.y-labelHeight/2,width:labelWidth,height:labelHeight };
      if (rect.x < viewport.left || rect.x + rect.width > viewport.right || rect.y < viewport.top || rect.y + rect.height > viewport.bottom) continue;
      if (occupied.some(other => overlaps(rect, other))) continue;
      visible.add(node.id); occupied.push(rect);
      let label = labels.get(node.id);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'library-label'; label.dataset.nodeId = node.id;
        const title = document.createElement('span'); title.className = 'library-label-name';
        const delta = document.createElement('span'); delta.className = 'library-label-change';
        label.append(title, delta); labelHost.append(label); labels.set(node.id, label);
        label.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) select(node.id); });
        label.addEventListener('focus', () => setHovered(node.id)); label.addEventListener('blur', () => setHovered(null));
      }
      label.querySelector('.library-label-name').textContent = name;
      label.querySelector('.library-label-change').textContent = badge;
      label.querySelector('.library-label-change').hidden = !badge;
      label.title = node.path || 'XOZU'; label.setAttribute('aria-pressed', String(node.id === selectedId));
      label.setAttribute('aria-label', `${node.path || 'XOZU'}、${node.fileCount}冊${badge ? `、差分 ${badge}` : ''}`);
      label.dataset.type = node.type; label.dataset.selected = String(node.id === selectedId);
      Object.assign(label.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, display: 'grid' });
      label.style.setProperty('--library-color', entry.color);
    }
    for (const [id, label] of labels) if (!visible.has(id)) label.style.display = 'none';
  }
  function setHovered(id, point = null) {
    if (hoveredId === id) return;
    hoveredId = id; canvas.style.cursor = id === null ? 'grab' : 'pointer'; onHover(id, point); requestDraw();
  }
  function currentRegion() {
    if (!camera || camera.scale < referenceScale * 1.15) return '';
    const point = unprojectFlatPoint(camera, flatViewportCenter(referenceViewport)); let current = '';
    for (const entry of visualNodes) if (entry.node.type === 'folder' && entry.node.id.length >= current.length
      && libraryNodeContainsPoint(entry.node,point)) current = entry.node.id;
    return current;
  }
  function reportState() {
    const state = { regionId: currentRegion(), zoom: camera.scale / referenceScale, frameIndex, comparisonMode,
      comparisonStatus: comparison.status, displayRevision: town.revision, paletteId,
      visibleFolders: visualNodes.filter(entry => entry.node.type === 'folder').length,
      visibleFiles: visualNodes.filter(entry => entry.node.type === 'file').length,
      pins: { aggregation: 'folders', total: pins.length },books:town.books.length,towerLevels:town.tower.levels };
    const signature = JSON.stringify(state); if (signature !== lastState) { lastState = signature; onChange(state); }
  }
  function draw(now) {
    renderRequest = null; if (disposed) return;
    try {
      applyGesture(gesture.flush());
      if (animation) {
        const progress = clamp((now - animation.started) / animation.duration, 0, 1); const amount = progress * progress * (3 - 2 * progress);
        camera = { ...camera, center: { x: animation.from.center.x + (animation.to.center.x - animation.from.center.x) * amount,
          y: animation.from.center.y + (animation.to.center.y - animation.from.center.y) * amount },
          scale: Math.exp(Math.log(animation.from.scale) + (Math.log(animation.to.scale) - Math.log(animation.from.scale)) * amount) };
        if (progress === 1) animation = null;
      }
      visualNodes = collectVisuals(); drawMap(); paintLabels(); reportState(); instantFocus = null;
    } catch (error) { animation = null; gesture.cancel(); onError(error); }
    if (animation || gesture.pending()) requestDraw();
  }
  function select(id) { if (town.nodes.has(id)) { selectedId = id; requestDraw(); onSelect(id); } }
  function pick(point) {
    const world = unprojectFlatPoint(camera, point);
    const picked=[...visualNodes].reverse().find(entry=>entry.node.id&&libraryNodeContainsPoint(entry.node,world))?.node;
    if(picked)return picked;
    return containsPoint(boxPolygon(boxFor(town.root)),world)?town.root:null;
  }
  function fitNode(id, viewport = camera.viewport) { return fitFlatCamera(town.nodes.get(id) ?? town.root, viewport, id ? .76 : .9); }
  function focus(id = '', animate = true) {
    if (!town.nodes.has(id)) return;
    setHovered(null); focusedId = id; cameraTouched = false;
    if (!isFlatViewportUsable(camera.viewport)) { deferredFocus = { id, animate }; animation = null; instantFocus = null; requestDraw(); return; }
    deferredFocus = null; const destination = fitNode(id);
    if (reducedMotion || !animate) { camera = destination; animation = null; instantFocus = id; }
    else { instantFocus = null; animation = { from: camera, to: destination, started: performance.now(), duration: 300 }; }
    requestDraw();
  }
  function setPinViewport(bounds) {
    requestedViewport = { ...bounds };
    const viewport = normalizeFlatViewport(bounds, { width, height }); hasExternalViewport = true;
    const usable = isFlatViewportUsable(viewport); const calibrating = usable && !viewportCalibrated;
    const resized = resizedViewport && usable; const relativeZoom = camera.scale / referenceScale;
    if (calibrating || resized) { referenceScale = fitNode('', viewport).scale; referenceViewport = { ...viewport }; viewportCalibrated = true; }
    if (!calibrating && !resized && sameBounds(viewport, camera.viewport)) return;
    camera = resized ? { ...camera, viewport: { ...viewport }, scale: referenceScale * relativeZoom } : reframeFlatViewport(camera, viewport);
    if(resized)resizedViewport=false;
    if (!usable) {
      if (animation || instantFocus !== null) deferredFocus = { id: focusedId, animate: !reducedMotion };
      animation = null; instantFocus = null;
    } else if (deferredFocus) { const pending = deferredFocus; focus(pending.id, pending.animate); }
    else if (animation) {
      const now = performance.now(); const remaining = animation.duration - (now - animation.started);
      animation = { from: camera, to: fitNode(focusedId), started: now, duration: Math.max(80, remaining) };
    } else if (!cameraTouched && (calibrating || resized || instantFocus !== null)) camera = fitNode(focusedId);
    requestDraw();
  }
  function zoom(factor, point) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    animation = null; deferredFocus = null; instantFocus = null; cameraTouched = true;
    camera = zoomFlatCamera(camera, factor, point, { minimum: referenceScale * .45, maximum: 4096 }); requestDraw();
  }
  function pan(from, to) {
    animation = null; deferredFocus = null; instantFocus = null; cameraTouched = true;
    camera = panFlatCamera(camera, from, to); setHovered(null); requestDraw();
  }
  function applyGesture(movement) { if (movement?.zoom) zoom(movement.zoom.factor, movement.zoom.point); if (movement?.pan) pan(movement.pan.from, movement.pan.to); }
  function eventPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function resize() {
    const rect = canvas.getBoundingClientRect(); const nextWidth = Math.max(1, rect.width), nextHeight = Math.max(1, rect.height), nextRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (camera && nextWidth === width && nextHeight === height && nextRatio === ratio) return;
    if(camera&&(nextWidth!==width||nextHeight!==height))resizedViewport=true;
    width = nextWidth; height = nextHeight; ratio = nextRatio;
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    const viewport = normalizeFlatViewport(hasExternalViewport ? camera?.viewport : null, { width, height });
    camera = camera ? { ...camera, viewport: { ...viewport } } : fitNode('', viewport);
    referenceScale ??= camera.scale; referenceViewport ??= { ...viewport };
    if(hasExternalViewport&&requestedViewport)setPinViewport(requestedViewport);
    requestDraw();
  }
  const isMapPointer = event => event.target === canvas || labelHost.contains(event.target);
  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(surface, 'wheel', event => { if (!isMapPointer(event)) return; event.preventDefault(); zoom(Math.exp(-clamp(event.deltaY, -150, 150) * .0035), eventPoint(event)); }, { passive: false });
  listen(surface, 'pointerdown', event => {
    if (event.button !== 0 || !isMapPointer(event)) return;
    animation = null; deferredFocus = null; instantFocus = null; setHovered(null);
    gesture.begin(event.pointerId, eventPoint(event), event.target.closest?.('.library-label')?.dataset.nodeId ?? null);
    canvas.setPointerCapture(event.pointerId); canvas.focus();
  });
  listen(surface, 'pointermove', event => {
    const point = eventPoint(event);
    if (!gesture.has(event.pointerId)) { if (isMapPointer(event)) setHovered(event.target.closest?.('.library-label')?.dataset.nodeId ?? pick(point)?.id ?? null, point); return; }
    applyGesture(gesture.move(event.pointerId, point)); if (gesture.pending()) requestDraw();
  });
  listen(surface, 'pointerup', event => {
    if (!gesture.has(event.pointerId)) return;
    applyGesture(gesture.flush()); const tap = gesture.end(event.pointerId, eventPoint(event));
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    canvas.style.cursor = 'grab';
    if (tap) { const id = tap.labelId ?? pick(tap.point)?.id; if (id !== undefined) select(id); }
  });
  listen(surface, 'pointercancel', () => { gesture.cancel(); setHovered(null); canvas.style.cursor = 'grab'; });
  listen(surface, 'pointerleave', () => setHovered(null));
  listen(surface, 'dblclick', event => {
    if (!isMapPointer(event)) return;
    const id = event.target.closest?.('.library-label')?.dataset.nodeId ?? pick(eventPoint(event))?.id;
    if (id !== undefined) { event.preventDefault(); selectedId = id; focus(id); onNavigate(id); }
  });
  listen(canvas, 'keydown', event => {
    if (['+', '=', '-', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.4); else if (event.key === '-') zoom(1 / 1.4);
    else if (event.key === 'Home') { focus(''); onNavigate(''); }
    else { const delta = { ArrowLeft: [65, 0], ArrowRight: [-65, 0], ArrowUp: [0, 65], ArrowDown: [0, -65] }[event.key];
      if (delta) { const center = flatViewportCenter(camera.viewport); pan(center, { x: center.x + delta[0], y: center.y + delta[1] }); } }
  });
  updateTown(); resize(); const observer = new ResizeObserver(resize); observer.observe(canvas);
  return {
    focus, home: () => focus(''), zoom, resize, setPinViewport, setViewport: setPinViewport,
    setFrame(index) {
      if (!Number.isInteger(index) || index < 0 || index >= model.frames.length) throw new Error('library-frame-invalid');
      gesture.cancel(); animation = null; deferredFocus = null; instantFocus = null; pins = []; activePinPaths.clear(); frameIndex = index;
      updateTown();
    },
    setComparisonMode(mode) {
      if (!['diff', 'before', 'after'].includes(mode)) throw new Error('library-comparison-invalid');
      if (comparisonMode === mode) return;
      gesture.cancel(); animation = null; deferredFocus = null; instantFocus = null; comparisonMode = mode; updateTown();
    },
    setSelected(id) { selectedId = town.nodes.has(id) ? id : null; requestDraw(); },
    setPalette(id) { paletteId = normalizeMapPaletteId(id); requestDraw(); },
    setPins(nextPins) { pins = (Array.isArray(nextPins) ? nextPins : []).filter(pin => pin.revision === model.frames[frameIndex].revision); activePinPaths.clear(); requestDraw(); },
    setActivePins(ids = []) { const selected = new Set(ids); activePinPaths = new Set(pins.filter(pin => selected.has(pin.id)).map(pin => pin.path)); requestDraw(); },
    dispose() {
      if (disposed) return; disposed = true; gesture.cancel(); animation = null;
      if (renderRequest !== null) cancelAnimationFrame(renderRequest);
      observer.disconnect(); for (const remove of listeners) remove();
      labelHost.remove(); labels.clear(); townCache.clear(); canvas.classList.remove('library-canvas');
    },
  };
}
