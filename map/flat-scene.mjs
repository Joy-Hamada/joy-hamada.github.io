import { containsPoint, polygonArea } from './model.mjs';
import { strataDetail } from './strata-model.mjs';
import { expandStrataRegions } from './ancestral-model.mjs';
import { createMapPointerGesture } from './strata-interaction.mjs';
import { clusterMapPins, describeMapPinCluster } from './map-pins.mjs';
import { colorForMapPalette, normalizeMapPaletteId, defaultMapPaletteId } from './map-palette.mjs';
import { normalizeFlatViewport, fitFlatCamera, projectFlatPoint, unprojectFlatPoint, panFlatCamera, zoomFlatCamera,
  reframeFlatViewport, flatViewportCenter, flatNodeLabel, pickFlatNode, flatScaleLimits, isFlatViewportUsable } from './flat-camera.mjs';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const logicalId = node => node.logicalId ?? node.id;
const rectanglesOverlap = (first, second, gap = 5) => first.x < second.x + second.width + gap && first.x + first.width + gap > second.x
  && first.y < second.y + second.height + gap && first.y + first.height + gap > second.y;

export function createFlatScene({ canvas, model, initialFrameIndex = 0, onSelect = () => {}, onNavigate = () => {},
  onPinSelect = () => {}, onHover = () => {}, onChange = () => {}, onError = () => {} }) {
  if (!model?.map?.root.fileCount) throw new Error('empty-project-flat-map');
  const context = canvas.getContext('2d', { alpha: true });
  if (!context) throw new Error('project-flat-context-unavailable');
  const surface = canvas.parentElement; const listeners = [];
  const gesture = createMapPointerGesture({ rotate: false, tilt: false, coalesce: true });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 1; let height = 1; let ratio = 1; let frameIndex = initialFrameIndex;
  let logicalMap; let map; let entries = []; let camera;
  let paletteId = defaultMapPaletteId; let selectedId = ''; let selectedRegionId = null; let hoverId = null;
  let pins = []; let clusters = new Map(); let activePinIds = new Set(); let pinRects = [];
  let pinSummary = { visible: 0, offscreen: 0, unplaced: 0, total: 0 };
  let renderRequest = null; let disposed = false; let animation = null; let lastState = '';
  let externalViewport = false; let manualCamera = false; let pendingFocusId = ''; let pendingInstantFocus = false;
  let referenceViewport = null; let referenceScale = null; let referenceCalibrated = false; let needsReferenceViewport = false; let deferredFocus = null;
  const labels = new Map(); const pinButtons = new Map();
  const labelHost = document.createElement('div'); labelHost.className = 'strata-labels flat-labels';
  const pinHost = document.createElement('div'); pinHost.className = 'strata-pins flat-pins';
  for (const host of [labelHost, pinHost]) {
    Object.assign(host.style, { position: 'absolute', inset: '0', overflow: 'hidden', pointerEvents: 'none', touchAction: 'none' });
    surface.append(host);
  }
  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options); listeners.push(() => target.removeEventListener(event, callback, options));
  }
  function requestDraw() { if (!disposed && renderRequest === null) renderRequest = requestAnimationFrame(draw); }
  function hasAppeared(node) { return (node.firstObserved ?? 0) <= frameIndex; }
  // Overlay occlusion does not change projected polygon pixels or the user's magnification.
  function readDetail() { return strataDetail(map, camera.scale); }
  function setHovered(id, point = null) {
    if (hoverId === id) return;
    hoverId = id; canvas.style.cursor = id === null ? 'grab' : 'pointer'; onHover(id, point); requestDraw();
  }
  function updateFrame() {
    logicalMap = model.mapFor?.(frameIndex) ?? model.map;
    map = expandStrataRegions(logicalMap);
    entries = map.orderedNodes.filter(hasAppeared).map(node => {
      const state = model.nodeState(logicalId(node), frameIndex);
      return { node, state, color: colorForMapPalette(node, { state, activity: model.activityFor(logicalId(node), frameIndex) }, paletteId).hex };
    }).sort((first, second) => first.node.depth - second.node.depth);
  }
  function tracePolygon(polygon) {
    context.beginPath(); polygon.forEach((point, index) => context[index ? 'lineTo' : 'moveTo'](point.x, point.y)); context.closePath();
  }
  function paintMap(detail) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    const origin = projectFlatPoint(camera, { x: 0, y: 0 });
    context.setTransform(ratio * camera.scale, 0, 0, ratio * camera.scale, ratio * origin.x, ratio * origin.y);
    for (const { node, state, color } of entries) {
      const visibility = detail.get(node.id); if (!visibility || visibility.opacity <= .005) continue;
      const corner = projectFlatPoint(camera, { x: node.bounds.x, y: node.bounds.y });
      if (corner.x > width || corner.y > height || corner.x + node.bounds.width * camera.scale < 0 || corner.y + node.bounds.height * camera.scale < 0) continue;
      tracePolygon(node.polygon); context.globalAlpha = visibility.opacity; context.fillStyle = color; context.fill();
      if (visibility.opacity <= .08) continue;
      const absent = state?.presentFiles === 0;
      const changed = state?.changeStatus === 'measured' && state.added + state.modified + state.deleted > 0;
      context.strokeStyle = absent ? '#697579' : node.type === 'file' && changed ? '#a27b45' : '#ffffff';
      context.lineWidth = (node.type === 'file' && state?.added > 0 ? 3 : 1) / camera.scale;
      if (node.type === 'file' && state?.added > 0) context.strokeStyle = '#254b43';
      context.setLineDash(absent ? [5 / camera.scale, 3 / camera.scale] : []); context.stroke();
    }
    const candidate = entries.find(entry => entry.node.id === selectedRegionId && logicalId(entry.node) === (hoverId ?? selectedId))
      ?? entries.find(entry => logicalId(entry.node) === (hoverId ?? selectedId));
    if (candidate && (hoverId !== null || selectedId)) {
      tracePolygon(candidate.node.polygon); context.globalAlpha = 1; context.strokeStyle = '#264f48';
      context.lineWidth = 2 / camera.scale; context.setLineDash([]); context.stroke();
    }
    context.globalAlpha = 1; context.setLineDash([]);
  }
  function selectPin(cluster) {
    if (!cluster) return;
    setHovered(null); setActivePins(cluster.members.map(pin => pin.id));
    onPinSelect(cluster.members.length === 1 ? cluster.members[0] : cluster);
  }
  function paintPins() {
    const viewport = camera.viewport;
    if (!isFlatViewportUsable(viewport)) {
      clusters.clear(); pinRects = [];
      for (const button of pinButtons.values()) button.remove(); pinButtons.clear();
      const located = pins.filter(pin => Number.isFinite(pin.world?.x) && Number.isFinite(pin.world?.y)).length;
      pinSummary = { visible: 0, offscreen: located, unplaced: pins.length - located, total: pins.length }; return;
    }
    const left = Math.min(viewport.right, viewport.left + 24); const top = Math.min(viewport.bottom, viewport.top + 24);
    const bounds = { left, top, right: Math.max(left, viewport.right - 24), bottom: Math.max(top, viewport.bottom - 24) };
    const projected = pins.map(pin => ({ ...pin, screen: Number.isFinite(pin.world?.x) && Number.isFinite(pin.world?.y) ? projectFlatPoint(camera, pin.world) : null }));
    const grouped = clusterMapPins(projected, { bounds, radius: 44 });
    clusters = new Map(grouped.clusters.map(cluster => [cluster.id, cluster])); pinRects = [];
    pinSummary = { visible: grouped.clusters.reduce((sum, cluster) => sum + cluster.count, 0),
      offscreen: grouped.offscreen.length, unplaced: grouped.unplaced.length, total: grouped.total };
    for (const cluster of grouped.clusters) {
      let x = cluster.screen.x; let y = cluster.screen.y;
      const occupied = () => pinRects.some(rect => rectanglesOverlap({ x: x - 22, y: y - 22, width: 44, height: 44 }, rect));
      for (let attempt = 0; occupied() && attempt < 64; attempt += 1) {
        const radius = 50 * (1 + Math.floor(attempt / 8)); const angle = attempt * Math.PI / 4;
        x = clamp(cluster.screen.x + Math.cos(angle) * radius, bounds.left, bounds.right);
        y = clamp(cluster.screen.y + Math.sin(angle) * radius, bounds.top, bounds.bottom);
      }
      pinRects.push({ x: x - 22, y: y - 22, width: 44, height: 44 });
      let button = pinButtons.get(cluster.id);
      if (!button) {
        button = document.createElement('button'); button.type = 'button'; button.className = 'strata-pin'; button.dataset.pinId = cluster.id;
        Object.assign(button.style, { position: 'absolute', pointerEvents: 'auto', transform: 'translate(-50%,-50%)', width: '44px', height: '44px', padding: '0', boxSizing: 'border-box' });
        const count = document.createElement('span'); count.className = 'strata-pin-count'; count.setAttribute('aria-hidden', 'true');
        const stem = document.createElement('span'); stem.className = 'strata-pin-stem'; stem.setAttribute('aria-hidden', 'true');
        button.append(count, stem);
        button.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) selectPin(clusters.get(button.dataset.pinId)); });
        pinHost.append(button); pinButtons.set(cluster.id, button);
      }
      const description = describeMapPinCluster(cluster, activePinIds);
      button.dataset.kind = 'change'; button.dataset.count = String(cluster.count); button.dataset.selected = String(description.selected);
      button.querySelector('.strata-pin-count').textContent = description.countLabel;
      button.setAttribute('aria-label', description.ariaLabel); button.setAttribute('aria-pressed', String(description.selected)); button.title = description.ariaLabel;
      Object.assign(button.style, { left: `${x}px`, top: `${y}px`, display: 'block' });
      const horizontal = cluster.screen.x - x; const vertical = cluster.screen.y - y;
      Object.assign(button.querySelector('.strata-pin-stem').style, { position: 'absolute', left: '50%', top: '50%', width: '1px', height: `${Math.hypot(horizontal, vertical)}px`,
        transformOrigin: 'top', transform: `rotate(${-Math.atan2(horizontal, vertical)}rad)`, background: 'currentColor', opacity: '.35', pointerEvents: 'none' });
    }
    for (const [id, button] of pinButtons) if (!clusters.has(id)) { button.remove(); pinButtons.delete(id); }
  }
  function labelPoint(label) {
    const rect = label.getBoundingClientRect(); const canvasRect = canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 - canvasRect.left, y: rect.top - canvasRect.top };
  }
  function paintLabels(detail) {
    if (!isFlatViewportUsable(camera.viewport)) { for (const label of labels.values()) label.style.display = 'none'; return; }
    const candidates = entries.filter(({ node }) => logicalId(node) && detail.get(node.id)?.label)
      .sort((first, second) => polygonArea(second.node.polygon) - polygonArea(first.node.polygon));
    const occupied = [...pinRects]; const visible = new Set();
    for (const { node, state } of candidates) {
      const expanded = detail.get(node.id).expanded; let world = node.center;
      if (expanded) {
        const north = node.polygon.reduce((first, point) => point.y < first.y ? point : first);
        world = { x: node.center.x * .6 + north.x * .4, y: node.center.y * .6 + north.y * .4 };
      }
      const point = projectFlatPoint(camera, world); const labelText = flatNodeLabel(node, state);
      const span = Math.min(180, Math.max(55, labelText.length * (node.depth === 1 ? 7.4 : 6.4)));
      const rect = { x: point.x - span / 2, y: point.y - 12, width: span, height: 24 };
      const viewport = camera.viewport;
      if (rect.x < viewport.left || rect.x + rect.width > viewport.right || rect.y < viewport.top || rect.y + rect.height > viewport.bottom) continue;
      if (occupied.some(previous => rectanglesOverlap(rect, previous))) continue;
      if (visible.size >= 70) break;
      visible.add(node.id); occupied.push(rect);
      let label = labels.get(node.id);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'strata-label';
        label.dataset.nodeId = logicalId(node); label.dataset.regionId = node.id; label.title = node.path;
        Object.assign(label.style, { position: 'absolute', pointerEvents: 'auto', transform: 'translate(-50%,-50%)', whiteSpace: 'nowrap', border: '0', cursor: 'pointer', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis' });
        label.addEventListener('click', event => {
          event.stopPropagation(); if (event.detail > 0) return;
          selectedRegionId = node.id; setSelected(logicalId(node)); onSelect(logicalId(node));
        });
        label.addEventListener('dblclick', event => { event.stopPropagation(); selectedRegionId = node.id; focus(logicalId(node)); onNavigate(logicalId(node)); });
        label.addEventListener('pointerenter', () => { selectedRegionId = node.id; setHovered(logicalId(node), labelPoint(label)); });
        label.addEventListener('pointerleave', () => setHovered(null));
        label.addEventListener('focus', () => { selectedRegionId = node.id; setHovered(logicalId(node), labelPoint(label)); });
        label.addEventListener('blur', () => setHovered(null));
        labelHost.append(label); labels.set(node.id, label);
      }
      label.textContent = labelText;
      label.setAttribute('aria-label', `${node.path}、現版の配下${state?.presentFiles ?? 0}ファイル${state?.presentFiles === 0 ? '、削除済み' : ''}。ダブルクリックで内部へ`);
      Object.assign(label.style, { left: `${point.x}px`, top: `${point.y}px`, display: 'block', padding: '3px 6px', borderRadius: '5px',
        font: `${node.depth === 1 ? '600 13px' : '500 11px'} system-ui,sans-serif`, color: state?.presentFiles ? '#253e3b' : '#707976', background: expanded ? '#ffffffa6' : '#ffffffe8' });
    }
    for (const [id, label] of labels) if (!visible.has(id)) label.style.display = 'none';
  }
  function currentRegion(detail) {
    let region = logicalMap.root;
    if (camera.scale <= referenceScale * 1.08) return region;
    const point = unprojectFlatPoint(camera, flatViewportCenter(referenceViewport));
    for (const { node } of entries) {
      if (node.type !== 'folder' || node.depth <= region.depth || !detail.get(node.id)?.expanded || !containsPoint(node.polygon, point)) continue;
      const span = Math.max(node.bounds.width, node.bounds.height) * camera.scale;
      if (camera.scale >= fitFlatCamera(node, referenceViewport).scale * .9
        && span >= Math.min(referenceViewport.right - referenceViewport.left, referenceViewport.bottom - referenceViewport.top) * .48) region = logicalMap.nodes.get(logicalId(node));
    }
    return region;
  }
  function reportState(detail) {
    const frontier = entries.filter(({ node }) => logicalId(node) && detail.get(node.id)?.opacity > .5 && !detail.get(node.id).expanded);
    const state = { regionId: currentRegion(detail).id, zoom: camera.scale / referenceScale, frameIndex, paletteId,
      visibleFolders: frontier.filter(entry => entry.node.type === 'folder').length, visibleFiles: frontier.filter(entry => entry.node.type === 'file').length,
      center: { ...camera.center }, pins: { ...pinSummary } };
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
      const detail = readDetail(); paintMap(detail); paintPins(); paintLabels(detail); reportState(detail); pendingInstantFocus = false;
    } catch (error) { animation = null; gesture.cancel(); onError(error); }
    if (animation || gesture.pending()) requestDraw();
  }
  function focusedNode(id) {
    if (!id) return logicalMap.root;
    const region = map.nodes.get(selectedRegionId);
    return region && logicalId(region) === id && hasAppeared(region) ? region : entries.find(entry => logicalId(entry.node) === id)?.node;
  }
  function focus(id = '', animate = true) {
    const node = focusedNode(id); if (!node) return;
    setHovered(null); manualCamera = false; pendingFocusId = id;
    if (!isFlatViewportUsable(camera.viewport)) {
      deferredFocus = { id, animate }; animation = null; pendingInstantFocus = false; requestDraw(); return;
    }
    deferredFocus = null;
    const destination = fitFlatCamera(node, camera.viewport);
    if (reducedMotion || !animate) { camera = destination; animation = null; pendingInstantFocus = true; }
    else { pendingInstantFocus = false; animation = { from: camera, to: destination, started: performance.now(), duration: 320 }; }
    requestDraw();
  }
  function setFrame(index) {
    if (!Number.isInteger(index) || index < 0 || index >= model.frames.length) throw new Error('invalid-project-flat-frame');
    setHovered(null); animation = null; pendingInstantFocus = false; deferredFocus = null; gesture.cancel(); frameIndex = index;
    pins = []; clusters.clear(); activePinIds.clear();
    for (const button of pinButtons.values()) button.remove(); pinButtons.clear();
    for (const label of labels.values()) label.remove(); labels.clear();
    updateFrame(); requestDraw();
  }
  function setPins(nextPins) {
    pins = (Array.isArray(nextPins) ? nextPins : []).filter(pin => pin.kind === 'change' && pin.revision === model.frames[frameIndex].revision);
    activePinIds.clear(); gesture.cancel(); requestDraw();
  }
  function setActivePins(ids = []) {
    const available = new Set(pins.map(pin => pin.id)); activePinIds = new Set((Array.isArray(ids) ? ids : []).filter(id => available.has(id))); requestDraw();
  }
  function setPinViewport(bounds) {
    const viewport = normalizeFlatViewport(bounds, { width, height }); externalViewport = true;
    const usable = isFlatViewportUsable(viewport); const calibratedNow = usable && !referenceCalibrated;
    if (calibratedNow) { referenceScale = fitFlatCamera(logicalMap.root, viewport).scale; referenceCalibrated = true; }
    if (usable && (calibratedNow || needsReferenceViewport)) { referenceViewport = { ...viewport }; needsReferenceViewport = false; }
    if (!calibratedNow && ['left', 'top', 'right', 'bottom'].every(key => viewport[key] === camera.viewport[key])) return;
    if (!usable) {
      camera = reframeFlatViewport(camera, viewport);
      if (animation || pendingInstantFocus) deferredFocus = { id: pendingFocusId, animate: !reducedMotion };
      animation = null; pendingInstantFocus = false; requestDraw(); return;
    }
    if (deferredFocus) {
      const requested = deferredFocus; camera = reframeFlatViewport(camera, viewport);
      focus(requested.id, requested.animate); return;
    }
    const destination = () => fitFlatCamera(focusedNode(pendingFocusId) ?? logicalMap.root, viewport);
    if (animation) {
      const now = performance.now(); const remaining = animation.started + animation.duration - now;
      camera = reframeFlatViewport(camera, viewport);
      // Cancelling a focus on every sheet-resize callback strands the camera before its requested destination.
      animation = { from: camera, to: destination(), started: now, duration: Math.max(80, remaining) };
    } else camera = !manualCamera && (calibratedNow || pendingInstantFocus) ? destination() : reframeFlatViewport(camera, viewport);
    requestDraw();
  }
  function setSelected(id) { selectedId = logicalMap.nodes.has(id) ? id : ''; requestDraw(); }
  function setPalette(id) {
    const next = normalizeMapPaletteId(id); if (next === paletteId) return;
    paletteId = next; updateFrame(); requestDraw();
  }
  function zoom(factor, point = flatViewportCenter(camera.viewport)) {
    if (!Number.isFinite(factor) || factor <= 0) return;
    setHovered(null); animation = null; pendingInstantFocus = false; deferredFocus = null; manualCamera = true;
    camera = zoomFlatCamera(camera, factor, point, { minimum: Math.min(referenceScale * .65, .05), maximum: flatScaleLimits.maximum }); requestDraw();
  }
  function pan(from, to) {
    setHovered(null); animation = null; pendingInstantFocus = false; deferredFocus = null; manualCamera = true; camera = panFlatCamera(camera, from, to); requestDraw();
  }
  function applyGesture(movement) {
    if (movement?.zoom) zoom(movement.zoom.factor, movement.zoom.point);
    if (movement?.pan) { pan(movement.pan.from, movement.pan.to); canvas.style.cursor = 'grabbing'; }
  }
  function pick(point) {
    const node = pickFlatNode(map, readDetail(), unprojectFlatPoint(camera, point), frameIndex);
    if (node) selectedRegionId = node.id; return node ? { id: logicalId(node) } : null;
  }
  function eventPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function resize() {
    const rect = canvas.getBoundingClientRect(); const nextWidth = Math.max(1, rect.width); const nextHeight = Math.max(1, rect.height);
    const nextRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
    if (camera && width === nextWidth && height === nextHeight && ratio === nextRatio) return;
    if (camera && (width !== nextWidth || height !== nextHeight)) needsReferenceViewport = true;
    setHovered(null); width = nextWidth; height = nextHeight; ratio = nextRatio;
    canvas.width = Math.max(1, Math.round(width * ratio)); canvas.height = Math.max(1, Math.round(height * ratio));
    const viewport = normalizeFlatViewport(externalViewport ? camera?.viewport : null, { width, height });
    camera = camera ? reframeFlatViewport(camera, viewport) : fitFlatCamera(logicalMap.root, viewport);
    if (!externalViewport && !manualCamera) camera = fitFlatCamera(focusedNode(pendingFocusId) ?? logicalMap.root, viewport);
    referenceScale ??= camera.scale;
    if (!referenceViewport || needsReferenceViewport) referenceViewport = normalizeFlatViewport(null, { width, height });
    requestDraw();
  }
  const isMapPointer = event => event.target === canvas || labelHost.contains(event.target) || pinHost.contains(event.target);
  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(surface, 'wheel', event => {
    if (!isMapPointer(event)) return;
    event.preventDefault(); zoom(Math.exp(-clamp(event.deltaY, -150, 150) * .0035), eventPoint(event));
  }, { passive: false });
  listen(surface, 'pointerdown', event => {
    if (event.button !== 0 || !isMapPointer(event)) return;
    setHovered(null); animation = null; pendingInstantFocus = false; deferredFocus = null;
    const label = event.target.closest?.('.strata-label'); const pin = event.target.closest?.('.strata-pin');
    if (label) selectedRegionId = label.dataset.regionId;
    gesture.begin(event.pointerId, eventPoint(event), pin ? { pinId: pin.dataset.pinId } : label?.dataset.nodeId ?? null);
    (pin ? canvas : event.target).setPointerCapture(event.pointerId); canvas.focus();
  });
  listen(surface, 'pointermove', event => {
    const point = eventPoint(event);
    if (!gesture.has(event.pointerId)) {
      if (pinHost.contains(event.target)) { setHovered(null); return; }
      const label = event.target.closest?.('.strata-label');
      if (label && labelHost.contains(label)) setHovered(label.dataset.nodeId, labelPoint(label));
      else if (isMapPointer(event)) setHovered(pick(point)?.id ?? null, point);
      return;
    }
    applyGesture(gesture.move(event.pointerId, point)); if (gesture.pending()) requestDraw();
  });
  listen(surface, 'pointerup', event => {
    if (!gesture.has(event.pointerId)) return;
    applyGesture(gesture.flush()); const tap = gesture.end(event.pointerId, eventPoint(event));
    if (event.target.hasPointerCapture(event.pointerId)) event.target.releasePointerCapture(event.pointerId);
    canvas.style.cursor = 'grab';
    if (tap?.labelId?.pinId) selectPin(clusters.get(tap.labelId.pinId));
    else if (tap) { const selected = tap.labelId ? { id: tap.labelId } : pick(tap.point); if (selected) { setSelected(selected.id); onSelect(selected.id); } }
  });
  listen(surface, 'pointercancel', () => { gesture.cancel(); setHovered(null); canvas.style.cursor = 'grab'; });
  listen(surface, 'pointerleave', () => setHovered(null));
  listen(surface, 'dblclick', event => {
    if (pinHost.contains(event.target) || !isMapPointer(event)) return;
    const selected = pick(eventPoint(event)); if (selected) { event.preventDefault(); setSelected(selected.id); focus(selected.id); onNavigate(selected.id); }
  });
  listen(canvas, 'keydown', event => {
    if (['+', '=', '-', 'Home', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.4);
    else if (event.key === '-') zoom(1 / 1.4);
    else if (event.key === 'Home') { focus(''); onNavigate(''); }
    else {
      const delta = { ArrowLeft: [65, 0], ArrowRight: [-65, 0], ArrowUp: [0, 65], ArrowDown: [0, -65] }[event.key];
      if (delta) { const center = flatViewportCenter(camera.viewport); pan(center, { x: center.x + delta[0], y: center.y + delta[1] }); }
    }
  });
  updateFrame(); resize();
  const observer = new ResizeObserver(resize); observer.observe(canvas);
  return {
    focus, setFrame, setPins, setActivePins, setPinViewport, setSelected, setPalette, zoom, home: () => focus(''), resize,
    setDisplayZoom(value) { if (Number.isFinite(value) && value > 0) zoom(value / (camera.scale / referenceScale)); },
    dispose() {
      if (disposed) return; disposed = true; animation = null; gesture.cancel();
      if (renderRequest !== null) cancelAnimationFrame(renderRequest);
      observer.disconnect(); for (const remove of listeners) remove(); labelHost.remove(); pinHost.remove();
      labels.clear(); pinButtons.clear(); entries = []; pins = []; clusters.clear(); activePinIds.clear();
    },
  };
}
