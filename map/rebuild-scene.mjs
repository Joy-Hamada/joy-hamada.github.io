import { buildRevisionTown, compareRevisionTrees } from './rebuild-model.mjs';
import { createMapPointerGesture } from './strata-interaction.mjs';
import { colorForMapPalette, defaultMapPaletteId, normalizeMapPaletteId } from './map-palette.mjs';
import { containsPoint } from './model.mjs';
import { normalizeFlatViewport, fitFlatCamera, projectFlatPoint, unprojectFlatPoint, panFlatCamera, zoomFlatCamera,
  reframeFlatViewport, flatViewportCenter, isFlatViewportUsable } from './flat-camera.mjs';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const paper = '#F7F5EE';
const ink = '#334C47';
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

export function createRebuildScene({ canvas, model, initialFrameIndex = 0, onSelect = () => {}, onNavigate = () => {},
  onHover = () => {}, onChange = () => {}, onError = () => {} }) {
  const context = canvas.getContext('2d', { alpha: true });
  if (!context || !model?.frames?.length) throw new Error('rebuild-scene-unavailable');
  const surface = canvas.parentElement; const listeners = []; const townCache = new Map();
  const labels = new Map(); const labelHost = document.createElement('div'); labelHost.className = 'rebuild-labels';
  surface.append(labelHost); canvas.classList.add('rebuild-canvas');
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
    if (!townCache.has(index)) townCache.set(index, buildRevisionTown(model.frames[index]));
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
  function canOpen(node, box) {
    return node.children.length > 0 && Math.min(box.width, box.height) * camera.scale >= 150
      && box.width * box.height * camera.scale ** 2 >= 45000;
  }
  function collectVisuals() {
    const visible = [];
    function visit(node, root = false) {
      const box = boxFor(node); if (!isVisible(box) && !root) return;
      const expanded = canOpen(node, box);
      visible.push({ node, box, expanded, color: nodeColor(node) });
      if (root) {
        for (const id of node.children) {
          const child = town.nodes.get(id);
          if (child && (child.type === 'folder' || expanded)) visit(child);
        }
      } else if (expanded) for (const id of node.children) { const child = town.nodes.get(id); if (child) visit(child); }
    }
    visit(town.root, true); return visible;
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
  function drawHub(entry) {
    const { box, expanded } = entry; const center = boxCenter(box);
    fillBox({ ...box, y: box.y + 5 }, '#DBE0D6', null, 0, 22);
    fillBox(box, '#E8EBDF', '#92A39A', 2, 22);
    const inset = Math.min(box.width, box.height) * .13;
    fillBox({ x: box.x + inset, y: box.y + inset, width: box.width - inset * 2, height: box.height - inset * 2 }, paper, '#C7D0C4', 1, 16);
    if (!expanded) {
      const side = Math.min(box.width, box.height) * .22;
      fillBox({ x: center.x - side / 2, y: center.y - side / 2, width: side, height: side }, '#FDFDF7', '#92A39A', 1.5, 4);
      line({ x: center.x - side * .3, y: center.y }, { x: center.x + side * .3, y: center.y }, '#92A39A', 1.5);
      line({ x: center.x, y: center.y - side * .3 }, { x: center.x, y: center.y + side * .3 }, '#92A39A', 1.5);
    }
  }
  function drawCompound(entry) {
    const { node, box, color, expanded } = entry;
    if (node.id === '') { drawHub(entry); return; }
    const small = Math.min(box.width, box.height); const rim = small * .065;
    const dark = blend(color, ink, .36); const ground = blend(color, paper, .8);
    fillBox({ ...box, y: box.y + small * .035 }, '#D5DBD0', null, 0, small * .1);
    fillBox(box, ground, dark, Math.max(1, rim * .24), small * .08);
    const inner = { x: box.x + rim, y: box.y + rim, width: box.width - rim * 2, height: box.height - rim * 2 };
    if (node.theme === 'garden') {
      fillBox(inner, blend(color, '#EDF2DB', .64), blend(color, '#68856B', .35), rim * .42, small * .12);
      if (!expanded) {
        line({ x: box.x + box.width / 2, y: box.y + rim }, { x: box.x + box.width / 2, y: box.y + box.height - rim }, paper, rim * 1.1);
        line({ x: box.x + rim, y: box.y + box.height / 2 }, { x: box.x + box.width - rim, y: box.y + box.height / 2 }, paper, rim * 1.1);
      }
    } else if (node.theme === 'castle' || node.theme === 'archive') {
      fillBox(inner, paper, blend(color, '#FFFFFF', .3), rim * .65, small * .035);
      const tower = rim * 1.65;
      for (const x of [box.x, box.x + box.width - tower]) for (const y of [box.y, box.y + box.height - tower]) {
        fillBox({ x, y, width: tower, height: tower }, color, dark, rim * .18, tower * .12);
        fillBox({ x: x + tower * .3, y: y + tower * .3, width: tower * .4, height: tower * .4 }, ground, null, 0, 0);
      }
      if (!expanded) {
        for (let index = 1; index < 5; index += 1) {
          const x = box.x + box.width * index / 5;
          fillBox({ x: x - rim * .36, y: box.y - rim * .18, width: rim * .72, height: rim * .95 }, color, dark, rim * .12, 1);
        }
      }
    } else if (node.theme === 'workshop') {
      fillBox(inner, paper, blend(color, '#FFFFFF', .25), rim * .55, small * .03);
      const height = rim * 1.25;
      for (let index = 0; index < 3; index += 1) {
        const x = inner.x + inner.width * index / 3;
        context.beginPath(); context.moveTo(x, inner.y); context.lineTo(x + inner.width / 6, inner.y - height);
        context.lineTo(x + inner.width / 3, inner.y); context.closePath(); context.fillStyle = color; context.fill();
      }
    } else {
      fillBox(inner, paper, color, rim * .75, small * .06);
      if (!expanded && node.theme === 'court') {
        line({ x: inner.x + inner.width / 2, y: inner.y }, { x: inner.x + inner.width / 2, y: inner.y + inner.height }, blend(color, paper, .45), rim * .35);
      }
    }
  }
  function drawFile(entry) {
    const { box, color } = entry; const small = Math.min(box.width, box.height);
    fillBox(box, blend(color, paper, .37), blend(color, ink, .3), Math.min(1.1 / camera.scale, small * .04), Math.min(5, small * .12));
    if (Math.min(box.width, box.height) * camera.scale > 25) {
      line({ x: box.x + box.width * .17, y: box.y + box.height * .28 },
        { x: box.x + box.width * .7, y: box.y + box.height * .28 }, blend(color, ink, .22), Math.min(1.2 / camera.scale, small * .04));
    }
  }
  function drawMap() {
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    context.fillStyle = paper; context.fillRect(0, 0, width, height);
    const origin = projectFlatPoint(camera, { x: 0, y: 0 });
    context.setTransform(camera.scale * ratio, 0, 0, camera.scale * ratio, origin.x * ratio, origin.y * ratio);
    context.setLineDash([]);
    const hub = boxCenter(boxFor(town.root));
    for (const landmark of town.landmarks) {
      const target = boxCenter(boxFor(landmark));
      line(hub, target, '#DFE3D7', 12); line(hub, target, '#FFFDF7', 7);
    }
    for (const entry of visualNodes) {
      if (entry.node.type === 'folder') drawCompound(entry); else drawFile(entry);
      const changes = visibleChange(entry.node, entry.expanded);
      const containsSelection = !entry.expanded && entry.node.id && (selectedId?.startsWith(`${entry.node.id}/`)
        || [...activePinPaths].some(path => path.startsWith(`${entry.node.id}/`)));
      const selected = entry.node.id === selectedId || entry.node.id === hoveredId || activePinPaths.has(entry.node.id) || containsSelection;
      if (changes || selected) {
        roundBox(entry.box, Math.min(entry.box.width, entry.box.height) * .08);
        context.strokeStyle = selected ? '#284B43' : '#9A6D35'; context.lineWidth = (selected ? 2.8 : 1.6) / camera.scale;
        context.setLineDash(selected ? [] : [4 / camera.scale, 3 / camera.scale]); context.stroke(); context.setLineDash([]);
      }
    }
  }
  function paintLabels() {
    const visible = new Set(); const occupied = []; const viewport = camera.viewport;
    if (isFlatViewportUsable(viewport)) for (const entry of visualNodes) {
      const { node, box, expanded } = entry;
      const projectedWidth = box.width * camera.scale; const projectedHeight = box.height * camera.scale;
      if (node.type === 'file' && (projectedWidth < 62 || projectedHeight < 32)) continue;
      const changes = visibleChange(node, expanded); const badge = changeText(changes);
      const name = node.id === '' ? 'XOZU' : node.name;
      const point = projectFlatPoint(camera, node.type === 'folder' && !expanded
        ? { x: box.x + box.width / 2, y: box.y + box.height } : { x: box.x + box.width / 2, y: box.y });
      const labelWidth = Math.min(node.type === 'file' ? projectedWidth - 4 : 190, Math.max(54, name.length * 7.2 + 18, badge.length * 7 + 14));
      const labelHeight = badge ? 40 : 26;
      const rect = { x: point.x - labelWidth / 2, y: point.y + (node.type === 'file' ? 3 : expanded ? 3 : 5), width: labelWidth, height: labelHeight };
      if (rect.x < viewport.left || rect.x + rect.width > viewport.right || rect.y < viewport.top || rect.y + rect.height > viewport.bottom) continue;
      if (occupied.some(other => overlaps(rect, other))) continue;
      visible.add(node.id); occupied.push(rect);
      let label = labels.get(node.id);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'rebuild-label'; label.dataset.nodeId = node.id;
        const title = document.createElement('span'); title.className = 'rebuild-label-name';
        const delta = document.createElement('span'); delta.className = 'rebuild-label-change';
        label.append(title, delta); labelHost.append(label); labels.set(node.id, label);
        label.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) select(node.id); });
        label.addEventListener('focus', () => setHovered(node.id)); label.addEventListener('blur', () => setHovered(null));
      }
      label.querySelector('.rebuild-label-name').textContent = name;
      label.querySelector('.rebuild-label-change').textContent = badge;
      label.querySelector('.rebuild-label-change').hidden = !badge;
      label.title = node.path || 'XOZU'; label.setAttribute('aria-pressed', String(node.id === selectedId));
      label.setAttribute('aria-label', `${node.path || 'XOZU'}、${node.fileCount}ファイル${badge ? `、差分 ${badge}` : ''}`);
      label.dataset.type = node.type; label.dataset.selected = String(node.id === selectedId);
      Object.assign(label.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, display: 'grid' });
      label.style.setProperty('--rebuild-color', entry.color);
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
      && containsPoint(boxPolygon(entry.box), point)) current = entry.node.id;
    return current;
  }
  function reportState() {
    const state = { regionId: currentRegion(), zoom: camera.scale / referenceScale, frameIndex, comparisonMode,
      comparisonStatus: comparison.status, displayRevision: town.revision, paletteId,
      visibleFolders: visualNodes.filter(entry => entry.node.type === 'folder').length,
      visibleFiles: visualNodes.filter(entry => entry.node.type === 'file').length,
      pins: { aggregation: 'folders', total: pins.length } };
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
    return [...visualNodes].reverse().find(entry => containsPoint(boxPolygon(entry.box), world))?.node ?? null;
  }
  function fitNode(id, viewport = camera.viewport) { return fitFlatCamera(town.nodes.get(id) ?? town.root, viewport, .76); }
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
    gesture.begin(event.pointerId, eventPoint(event), event.target.closest?.('.rebuild-label')?.dataset.nodeId ?? null);
    canvas.setPointerCapture(event.pointerId); canvas.focus();
  });
  listen(surface, 'pointermove', event => {
    const point = eventPoint(event);
    if (!gesture.has(event.pointerId)) { if (isMapPointer(event)) setHovered(event.target.closest?.('.rebuild-label')?.dataset.nodeId ?? pick(point)?.id ?? null, point); return; }
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
    const id = event.target.closest?.('.rebuild-label')?.dataset.nodeId ?? pick(eventPoint(event))?.id;
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
      if (!Number.isInteger(index) || index < 0 || index >= model.frames.length) throw new Error('rebuild-frame-invalid');
      gesture.cancel(); animation = null; deferredFocus = null; instantFocus = null; pins = []; activePinPaths.clear(); frameIndex = index;
      updateTown();
    },
    setComparisonMode(mode) {
      if (!['diff', 'before', 'after'].includes(mode)) throw new Error('rebuild-comparison-invalid');
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
      labelHost.remove(); labels.clear(); townCache.clear(); canvas.classList.remove('rebuild-canvas');
    },
  };
}
