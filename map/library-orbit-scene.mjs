import * as THREE from '/world/vendor/three.module.js';
import { compareRevisionTrees } from './rebuild-model.mjs';
import { buildLibraryOrbitModel, createLibraryOrbitState, normalizeLibraryOrbit, rotateLibraryOrbit,
  zoomLibraryOrbit, orbitCameraPosition, focusLibraryOrbit, libraryOrbitConstraints } from './library-orbit-model.mjs';
import { colorForMapPalette, defaultMapPaletteId, normalizeMapPaletteId } from './map-palette.mjs';

const paper = '#fffefb';
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const fullTurn = Math.PI * 2;
const overlaps = (first, second) => first.left < second.right + 5 && first.right + 5 > second.left
  && first.top < second.bottom + 5 && first.bottom + 5 > second.top;

function disposeGroup(group) {
  const geometries = new Set(), materials = new Set();
  group.traverse(object => {
    if (object.isInstancedMesh) object.dispose();
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : object.material ? [object.material] : []) materials.add(material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  group.clear();
}

function arcGeometry(innerRadius, outerRadius, startAngle, endAngle, height) {
  const shape = new THREE.Shape();
  const steps = Math.max(4, Math.ceil((endAngle - startAngle) * 24));
  for (let index = 0; index <= steps; index++) {
    const angle = startAngle + (endAngle - startAngle) * index / steps;
    const x = Math.cos(angle) * outerRadius, y = -Math.sin(angle) * outerRadius;
    if (index === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
  }
  for (let index = steps; index >= 0; index--) {
    const angle = startAngle + (endAngle - startAngle) * index / steps;
    shape.lineTo(Math.cos(angle) * innerRadius, -Math.sin(angle) * innerRadius);
  }
  shape.closePath();
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, steps: 1 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

export function createLibraryOrbitScene({ canvas, model, initialFrameIndex = 0, onSelect = () => {},
  onNavigate = () => {}, onHover = () => {}, onChange = () => {}, onError = () => {} }) {
  if (!model?.frames?.length) throw new Error('library-frame-invalid');
  let context;
  try { context = canvas.getContext('webgl2', { alpha: false, antialias: true, powerPreference: 'high-performance' }); }
  catch { throw new Error('library-webgl-unavailable'); }
  if (!context) throw new Error('library-webgl-unavailable');
  const renderer = new THREE.WebGLRenderer({ canvas, context, alpha: false, antialias: true });
  renderer.setClearColor(paper, 1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, 1, 12000);
  const ambient = new THREE.HemisphereLight('#ffffff', '#c6ced2', 2.25);
  const sunlight = new THREE.DirectionalLight('#fff8e8', 3.4);
  sunlight.position.set(-350, 650, 450); sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024); sunlight.shadow.bias = -.0005; sunlight.shadow.normalBias = 1.2;
  const fill = new THREE.DirectionalLight('#c7e8ef', 1.1); fill.position.set(450, 220, -380);
  scene.add(ambient, sunlight, fill, sunlight.target);
  const surface = canvas.parentElement, listeners = [], labels = new Map(), pointers = new Map();
  const labelHost = document.createElement('div'); labelHost.className = 'library-orbit-labels';
  surface.append(labelHost); canvas.classList.add('library-orbit-canvas');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const raycaster = new THREE.Raycaster(), rayPoint = new THREE.Vector2(), projected = new THREE.Vector3();
  const temporary = new THREE.Object3D(), color = new THREE.Color();
  let frameIndex = initialFrameIndex, comparisonMode = 'diff', paletteId = defaultMapPaletteId;
  let world, comparison, orbit, worldGroup = new THREE.Group(), towerGroup, bookMesh, bookBands, pickables = [];
  let selectedId = null, hoveredId = null, focusedId = '', pins = [], activePaths = new Set();
  let width = 1, height = 1, pixelRatio = 1, viewport = { left: 0, top: 0, right: 1, bottom: 1 };
  let requestedViewport = null, hasViewport = false, animation = null, towerAnimation = null;
  let drawRequest = null, disposed = false, failed = false, lastState = '', observer;
  scene.add(worldGroup);

  function requestDraw() { if (!disposed && !failed && drawRequest === null) drawRequest = requestAnimationFrame(draw); }
  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options); listeners.push(() => target.removeEventListener(event, callback, options));
  }
  function material(hex, options = {}) { return new THREE.MeshStandardMaterial({ color: hex, roughness: .7, metalness: .04, ...options }); }
  function addMesh(group, geometry, paint, position, nodeId, castsShadow = true) {
    const mesh = new THREE.Mesh(geometry, paint);
    if (position) mesh.position.set(position.x || 0, position.y || 0, position.z || 0);
    mesh.castShadow = castsShadow; mesh.receiveShadow = true;
    group.add(mesh);
    if (nodeId !== undefined) { mesh.userData.nodeId = nodeId; pickables.push(mesh); }
    return mesh;
  }
  function nodeColor(node) { return colorForMapPalette(node, { activity: 2, state: { presentFiles: node.fileCount || 1 } }, paletteId).hex; }
  function hasSelection(id) { return id === selectedId || (selectedId && id.startsWith(`${selectedId}/`)) || activePaths.has(id); }
  function paintBooks() {
    if (!bookMesh) return;
    world.books.forEach((book, index) => {
      color.set(nodeColor(book.node));
      if (comparisonMode === 'diff' && comparison.status === 'measured' && !comparison.changes.some(change => change.path === book.id)) color.lerp(new THREE.Color('#f7f4ec'), .28);
      if (hasSelection(book.id) || hoveredId === book.id) color.lerp(new THREE.Color('#ffffff'), .28);
      bookMesh.setColorAt(index, color);
      const change = comparisonMode === 'diff' ? comparison.changes.find(item => item.path === book.id) : null;
      bookBands.setColorAt(index, color.set(hasSelection(book.id) ? '#294d62' : change?.status === 'added' ? '#f4bc66' : change ? '#688da3' : '#e5dfcf'));
    });
    if (bookMesh.instanceColor) bookMesh.instanceColor.needsUpdate = true;
    if (bookBands.instanceColor) bookBands.instanceColor.needsUpdate = true;
  }
  function buildBooks(ivory) {
    const count = world.books.length, box = new THREE.BoxGeometry(1, 1, 1);
    bookMesh = new THREE.InstancedMesh(box, material('#ffffff', { roughness: .58 }), count);
    const pages = new THREE.InstancedMesh(box, ivory, count);
    bookBands = new THREE.InstancedMesh(box, material('#ffffff', { metalness: .3, roughness: .45 }), count);
    for (const mesh of [bookMesh, pages, bookBands]) { mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh); }
    world.books.forEach((book, index) => {
      const { position, size, yaw } = book;
      temporary.position.set(position.x, position.y, position.z); temporary.rotation.set(0, yaw, 0);
      temporary.scale.set(size.width, size.height, size.depth); temporary.updateMatrix(); bookMesh.setMatrixAt(index, temporary.matrix);
      temporary.position.set(position.x, position.y + size.height * .5 + .1, position.z);
      temporary.scale.set(size.width * .74, .45, size.depth * .85); temporary.updateMatrix(); pages.setMatrixAt(index, temporary.matrix);
      temporary.position.set(position.x + Math.sin(yaw) * (size.depth / 2 + .15), position.y + size.height * .24,
        position.z + Math.cos(yaw) * (size.depth / 2 + .15));
      temporary.scale.set(size.width * .74, 1.1, .5); temporary.updateMatrix(); bookBands.setMatrixAt(index, temporary.matrix);
    });
    for (const mesh of [bookMesh, pages, bookBands]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
    bookMesh.userData.bookInstances = true; pickables.push(bookMesh); paintBooks();
  }
  function buildTower(ivory, trim) {
    towerGroup = new THREE.Group(); worldGroup.add(towerGroup);
    const tower = world.tower, baseRadius = tower.radius;
    addMesh(towerGroup, new THREE.CylinderGeometry(baseRadius + 18, baseRadius + 23, 5, 80), ivory, { y: 3 }, '');
    addMesh(towerGroup, new THREE.CylinderGeometry(baseRadius + 11, baseRadius + 16, 8, 80), ivory, { y: 9 }, '');
    const palette = world.library.landmarks.map(node => nodeColor(node));
    if (!palette.length) palette.push('#8dd3c7', '#bebada', '#fdb462');
    tower.tiers.forEach((tier, index) => {
      const tint = material(palette[index % palette.length], { roughness: .48, metalness: .12 });
      const centerY = tier.y + tier.height / 2;
      addMesh(towerGroup, new THREE.CylinderGeometry(tier.topRadius * .7, tier.bottomRadius * .68, tier.height, 48), ivory, { y: centerY }, '');
      const eaveY = tier.y + tier.height * .84;
      addMesh(towerGroup, new THREE.CylinderGeometry(tier.topRadius * .35, tier.bottomRadius + 5, tier.height * .3, 64), ivory, { y: eaveY }, '');
      addMesh(towerGroup, new THREE.CylinderGeometry(tier.bottomRadius + 5, tier.bottomRadius + 5, 2.4, 64), tint, { y: eaveY - tier.height * .15 }, '');
      const ring = addMesh(towerGroup, new THREE.TorusGeometry(tier.bottomRadius * .67, 1.3, 6, 64), trim, { y: tier.y + 3 }, '');
      ring.rotation.x = Math.PI / 2;
      for (let spoke = 0; spoke < 8; spoke++) {
        const angle = spoke / 8 * fullTurn, radius = tier.bottomRadius * .58;
        addMesh(towerGroup, new THREE.CylinderGeometry(1.35, 1.65, tier.height * .53, 6), trim,
          { x: Math.cos(angle) * radius, y: tier.y + tier.height * .28, z: Math.sin(angle) * radius }, '');
      }
    });
    addMesh(towerGroup, new THREE.ConeGeometry(12, 30, 48), ivory, { y: tower.height - 15 }, '');
    addMesh(towerGroup, new THREE.SphereGeometry(3.3, 16, 12), trim, { y: tower.height + 3 }, '');
    const halo = addMesh(towerGroup, new THREE.TorusGeometry(17, .8, 6, 56), trim, { y: tower.height - 20 }, '');
    halo.rotation.x = Math.PI / 2;
  }
  function rebuildWorld() {
    const previousHeight = world?.tower.height;
    const before = frameIndex > 0 ? model.frames[frameIndex - 1] : null;
    comparison = compareRevisionTrees(before, model.frames[frameIndex]);
    world = buildLibraryOrbitModel(comparisonMode === 'before' && before ? before : model.frames[frameIndex]);
    if (selectedId !== null && !world.library.nodes.has(selectedId)) selectedId = null;
    if (!world.library.nodes.has(focusedId)) focusedId = '';
    disposeGroup(worldGroup); pickables = [];
    const ivory = material('#fffdf6'), trim = material('#cfc1a1', { metalness: .52, roughness: .42 });
    const base = material('#f1eee5');
    addMesh(worldGroup, new THREE.CylinderGeometry(world.radius + 22, world.radius + 27, 10, 160), base, { y: -5 }, '', false);
    addMesh(worldGroup, new THREE.CylinderGeometry(world.radius + 21, world.radius + 21, 1.2, 160), ivory, { y: .7 }, '', false);
    const rim = addMesh(worldGroup, new THREE.TorusGeometry(world.radius + 19, 1.1, 5, 160), trim, { y: 1.7 }, '', false); rim.rotation.x = Math.PI / 2;
    for (const shelf of world.shelves) {
      const shelfId = world.library.nodes.has(shelf.sector) ? shelf.sector : '';
      addMesh(worldGroup, arcGeometry(shelf.innerRadius - 2, shelf.outerRadius + 2, shelf.startAngle, shelf.endAngle, 4), ivory, { y: shelf.baseY }, shelfId);
      addMesh(worldGroup, arcGeometry(shelf.innerRadius - 2, shelf.outerRadius + 2, shelf.startAngle, shelf.endAngle, 2.4), ivory, { y: shelf.baseY + shelf.height }, shelfId);
      for (const angle of [shelf.startAngle, shelf.endAngle]) {
        const post = addMesh(worldGroup, new THREE.BoxGeometry(2.7, shelf.height, shelf.outerRadius - shelf.innerRadius + 4), ivory,
          { x: Math.cos(angle) * (shelf.innerRadius + shelf.outerRadius) / 2, y: shelf.baseY + shelf.height / 2,
            z: Math.sin(angle) * (shelf.innerRadius + shelf.outerRadius) / 2 }, shelfId);
        post.rotation.y = Math.PI / 2 - angle;
      }
    }
    buildBooks(ivory); buildTower(ivory, trim);
    sunlight.shadow.camera.left = sunlight.shadow.camera.bottom = -world.radius - 100;
    sunlight.shadow.camera.right = sunlight.shadow.camera.top = world.radius + 100;
    sunlight.shadow.camera.far = 1600; sunlight.shadow.camera.updateProjectionMatrix();
    orbit = orbit ? normalizeLibraryOrbit(orbit, world) : createLibraryOrbitState(world, { aspect: viewportAspect() });
    if (!reducedMotion && previousHeight && previousHeight !== world.tower.height) {
      towerAnimation = { started: performance.now(), from: previousHeight / world.tower.height };
      towerGroup.scale.y = towerAnimation.from;
    } else towerAnimation = null;
    setHovered(null); requestDraw();
  }
  function viewportAspect() { return Math.max(.25, (viewport.right - viewport.left) / Math.max(1, viewport.bottom - viewport.top)); }
  function viewportUsable() { return viewport.right - viewport.left > 16 && viewport.bottom - viewport.top > 16; }
  function updateCamera() {
    const position = orbitCameraPosition(orbit, world);
    camera.position.set(position.x, position.y, position.z); camera.lookAt(world.target.x, world.target.y, world.target.z);
    camera.aspect = viewportAspect(); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }
  function badgeFor(id) {
    if (comparisonMode !== 'diff' || comparison.status !== 'measured') return '';
    const group = comparison.groups.get(id);
    if (group) return [['+', group.added], ['~', group.modified], ['−', group.deleted]].filter(([, count]) => count).map(([mark, count]) => `${mark}${count}`).join(' ');
    const change = comparison.changes.find(item => item.path === id);
    return change ? change.status === 'added' ? '+' : change.status === 'modified' ? '~' : '−' : '';
  }
  function projectLabel(node) {
    const center = node.id ? node.center : { x: 0, y: 0 };
    projected.set(center.x, node.id ? 58 : world.tower.height + 34, center.y).project(camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return { x: viewport.left + (projected.x + 1) / 2 * (viewport.right - viewport.left),
      y: viewport.top + (1 - projected.y) / 2 * (viewport.bottom - viewport.top) };
  }
  function paintLabels() {
    const occupied = [], visible = new Set();
    const chosen = selectedId !== null ? world.library.nodes.get(selectedId) : null;
    const focus = world.library.nodes.get(focusedId);
    const candidates = [chosen, hoveredId ? world.library.nodes.get(hoveredId) : null, world.library.root,
      ...(focusedId && focus?.type === 'folder' ? focus.children.map(id => world.library.nodes.get(typeof id === 'string' ? id : id.id)) : []),
      ...world.library.landmarks].filter(Boolean);
    for (const node of candidates) {
      if (visible.has(node.id) || node.type === 'file' && node.id !== selectedId && node.id !== hoveredId) continue;
      const point = projectLabel(node); if (!point) continue;
      const name = node.id ? node.name : 'XOZU', badge = badgeFor(node.id);
      const labelWidth = clamp(name.length * 6.7 + 26, 48, 142), labelHeight = badge ? 36 : 28;
      const box = { left: point.x - labelWidth / 2, right: point.x + labelWidth / 2, top: point.y - labelHeight, bottom: point.y };
      if (box.left < viewport.left || box.right > viewport.right || box.top < viewport.top || box.bottom > viewport.bottom || occupied.some(other => overlaps(box, other))) continue;
      occupied.push(box); visible.add(node.id);
      let label = labels.get(node.id);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'library-orbit-label'; label.dataset.nodeId = node.id;
        const nameElement = document.createElement('span'), changeElement = document.createElement('small'); label.append(nameElement, changeElement);
        label.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) select(node.id); });
        label.addEventListener('focus', () => setHovered(node.id)); label.addEventListener('blur', () => setHovered(null));
        labelHost.append(label); labels.set(node.id, label);
      }
      label.firstChild.textContent = name; label.lastChild.textContent = badge; label.lastChild.hidden = !badge;
      label.setAttribute('aria-label', `${node.path || 'XOZU'}、${node.fileCount}冊${badge ? `、差分 ${badge}` : ''}`);
      label.setAttribute('aria-pressed', String(selectedId === node.id)); label.title = node.path || 'XOZU';
      Object.assign(label.style, { display: 'grid', left: `${box.left}px`, top: `${box.top}px`, width: `${labelWidth}px` });
    }
    for (const [id, label] of labels) if (!visible.has(id)) label.style.display = 'none';
  }
  function reportState() {
    const constraints = libraryOrbitConstraints(world, { aspect: viewportAspect() });
    const state = { renderer: 'webgl', regionId: focusedId, zoom: constraints.fitDistance / orbit.distance, frameIndex,
      comparisonMode, comparisonStatus: comparison.status, displayRevision: world.library.revision, paletteId,
      books: world.books.length, towerLevels: world.tower.levels, towerHeight: world.tower.height,
      orbit: { yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance }, pins: { aggregation: 'folders', total: pins.length } };
    const signature = JSON.stringify(state); if (signature !== lastState) { lastState = signature; onChange(state); }
  }
  function fail(error) {
    if (disposed || failed) return; failed = true; cancelPointers(); animation = towerAnimation = null;
    if (drawRequest !== null) cancelAnimationFrame(drawRequest); drawRequest = null;
    labelHost.hidden = true; onError(error);
  }
  function draw(now) {
    drawRequest = null; if (disposed || failed) return;
    try {
      if (animation) {
        const progress = clamp((now - animation.started) / 420, 0, 1), amount = 1 - (1 - progress) ** 3;
        orbit = normalizeLibraryOrbit({ yaw: animation.from.yaw + animation.yawDelta * amount,
          pitch: animation.from.pitch + (animation.to.pitch - animation.from.pitch) * amount,
          distance: animation.from.distance + (animation.to.distance - animation.from.distance) * amount }, world);
        if (progress === 1) animation = null;
      }
      if (towerAnimation) {
        const progress = clamp((now - towerAnimation.started) / 560, 0, 1);
        towerGroup.scale.y = towerAnimation.from + (1 - towerAnimation.from) * (1 - (1 - progress) ** 3);
        if (progress === 1) towerAnimation = null;
      }
      renderer.setScissorTest(false); renderer.setViewport(0, 0, width, height); renderer.clear();
      if (viewportUsable()) {
        updateCamera(); renderer.setViewport(viewport.left, height - viewport.bottom, viewport.right - viewport.left, viewport.bottom - viewport.top);
        renderer.setScissor(viewport.left, height - viewport.bottom, viewport.right - viewport.left, viewport.bottom - viewport.top);
        renderer.setScissorTest(true); renderer.render(scene, camera); paintLabels();
      } else for (const label of labels.values()) label.style.display = 'none';
      reportState();
    } catch (error) { fail(error); }
    if (animation || towerAnimation) requestDraw();
  }
  function select(id) { if (!failed && world.library.nodes.has(id)) { selectedId = id; paintBooks(); requestDraw(); onSelect(id); } }
  function setHovered(id, point = null) {
    if (hoveredId === id) return; hoveredId = id; canvas.style.cursor = id === null ? 'grab' : 'pointer';
    paintBooks(); onHover(id, point); requestDraw();
  }
  function pick(point) {
    if (!viewportUsable() || point.x < viewport.left || point.x > viewport.right || point.y < viewport.top || point.y > viewport.bottom) return null;
    rayPoint.set((point.x - viewport.left) / (viewport.right - viewport.left) * 2 - 1, 1 - (point.y - viewport.top) / (viewport.bottom - viewport.top) * 2);
    raycaster.setFromCamera(rayPoint, camera);
    const hit = raycaster.intersectObjects(pickables, false)[0];
    return hit ? hit.object.userData.bookInstances ? world.books[hit.instanceId]?.id ?? null : hit.object.userData.nodeId : null;
  }
  function focus(id = '', animate = true) {
    if (failed || !world.library.nodes.has(id)) return;
    cancelPointers(); focusedId = id; setHovered(null);
    const destination = id ? focusLibraryOrbit(orbit, world, id) : createLibraryOrbitState(world, { aspect: viewportAspect() });
    if (reducedMotion || !animate) { orbit = destination; animation = null; }
    else animation = { from: { ...orbit }, to: destination, yawDelta: Math.atan2(Math.sin(destination.yaw - orbit.yaw), Math.cos(destination.yaw - orbit.yaw)), started: performance.now() };
    requestDraw();
  }
  function zoom(factor) { if (failed || !Number.isFinite(factor) || factor <= 0) return; animation = null; orbit = zoomLibraryOrbit(orbit, factor, world); requestDraw(); }
  function rotate(yaw, pitch) { if (failed) return; animation = null; orbit = rotateLibraryOrbit(orbit, { yaw, pitch }, world); setHovered(null); requestDraw(); }
  function applyViewport() {
    const bounds = requestedViewport || { left: 0, top: 0, right: width, bottom: height };
    viewport = { left: clamp(bounds.left || 0, 0, width), top: clamp(bounds.top || 0, 0, height),
      right: clamp(bounds.right ?? width, 0, width), bottom: clamp(bounds.bottom ?? height, 0, height) };
    if (!hasViewport && viewportUsable()) {
      orbit = createLibraryOrbitState(world, { aspect: viewportAspect() });
      if (requestedViewport) hasViewport = true;
    }
  }
  function setPinViewport(bounds) { requestedViewport = { ...bounds }; applyViewport(); requestDraw(); }
  function resize() {
    const rect = canvas.getBoundingClientRect(); width = Math.max(1, rect.width); height = Math.max(1, rect.height);
    pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 1.6); renderer.setPixelRatio(pixelRatio); renderer.setSize(width, height, false);
    applyViewport(); requestDraw();
  }
  function eventPoint(event) { const rect = canvas.getBoundingClientRect(); return { x: event.clientX - rect.left, y: event.clientY - rect.top }; }
  function cancelPointers() {
    const capturedIds = [...pointers.keys()]; pointers.clear();
    for (const id of capturedIds) if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    canvas.style.cursor = 'grab';
  }
  const isMapPointer = event => event.target === canvas || labelHost.contains(event.target);
  listen(canvas, 'webglcontextlost', event => { event.preventDefault(); fail(new Error('library-webgl-context-lost')); });
  listen(canvas, 'contextmenu', event => event.preventDefault());
  listen(surface, 'wheel', event => { if (!isMapPointer(event) || failed) return; event.preventDefault(); zoom(Math.exp(-clamp(event.deltaY, -160, 160) * .003)); }, { passive: false });
  listen(surface, 'pointerdown', event => {
    if (failed || event.button !== 0 || !isMapPointer(event)) return; event.preventDefault();
    const point = eventPoint(event); animation = null; setHovered(null);
    pointers.set(event.pointerId, { point, start: point, dragged: false, multiple: pointers.size > 0, labelId: event.target.closest?.('.library-orbit-label')?.dataset.nodeId });
    if (pointers.size > 1) for (const pointer of pointers.values()) pointer.multiple = true;
    canvas.setPointerCapture(event.pointerId); canvas.focus(); canvas.style.cursor = 'grabbing';
  });
  listen(surface, 'pointermove', event => {
    if (failed) return; const point = eventPoint(event), pointer = pointers.get(event.pointerId);
    if (!pointer) { if (isMapPointer(event) && event.pointerType !== 'touch') setHovered(event.target.closest?.('.library-orbit-label')?.dataset.nodeId ?? pick(point), point); return; }
    if (Math.hypot(point.x - pointer.start.x, point.y - pointer.start.y) > 6) pointer.dragged = true;
    if (pointers.size === 1 && pointer.dragged) rotate(-(point.x - pointer.point.x) * .006, (point.y - pointer.point.y) * .004);
    else if (pointers.size === 2) {
      const other = [...pointers.entries()].find(([id]) => id !== event.pointerId)[1];
      const previousDistance = Math.hypot(pointer.point.x - other.point.x, pointer.point.y - other.point.y);
      const nextDistance = Math.hypot(point.x - other.point.x, point.y - other.point.y);
      if (previousDistance > 5 && nextDistance > 5) zoom(nextDistance / previousDistance);
    }
    pointer.point = point;
  });
  listen(surface, 'pointerup', event => {
    const pointer = pointers.get(event.pointerId); if (!pointer) return;
    pointers.delete(event.pointerId); if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    if (!pointer.dragged && !pointer.multiple && Math.hypot(eventPoint(event).x - pointer.start.x, eventPoint(event).y - pointer.start.y) <= 6) {
      const id = pointer.labelId ?? pick(eventPoint(event)); if (id !== null && id !== undefined) select(id);
    }
    canvas.style.cursor = pointers.size ? 'grabbing' : 'grab';
  });
  listen(surface, 'pointercancel', () => { cancelPointers(); setHovered(null); });
  listen(canvas, 'lostpointercapture', event => { if (pointers.has(event.pointerId)) cancelPointers(); });
  listen(surface, 'pointerleave', () => { if (!pointers.size) setHovered(null); });
  listen(surface, 'dblclick', event => {
    if (failed || !isMapPointer(event)) return; const id = event.target.closest?.('.library-orbit-label')?.dataset.nodeId ?? pick(eventPoint(event));
    if (id !== null && id !== undefined) { event.preventDefault(); selectedId = id; focus(id); onNavigate(id); }
  });
  listen(canvas, 'keydown', event => {
    if (failed || !['+', '=', '-', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.25); else if (event.key === '-') zoom(.8);
    else if (event.key === 'Home') { focus(''); onNavigate(''); }
    else rotate(({ ArrowLeft: .16, ArrowRight: -.16 })[event.key] || 0, ({ ArrowUp: .09, ArrowDown: -.09 })[event.key] || 0);
  });
  function dispose() {
    if (disposed) return; disposed = true; cancelPointers(); animation = towerAnimation = null;
    if (drawRequest !== null) cancelAnimationFrame(drawRequest); observer?.disconnect();
    for (const remove of listeners) remove(); labelHost.remove(); labels.clear();
    disposeGroup(worldGroup); sunlight.shadow.map?.dispose(); renderer.dispose(); canvas.classList.remove('library-orbit-canvas');
  }
  try { rebuildWorld(); resize(); observer = new ResizeObserver(resize); observer.observe(canvas); }
  catch (error) { dispose(); throw error; }
  return {
    focus, home: () => focus(''), zoom, resize, setPinViewport, setViewport: setPinViewport,
    setFrame(index) {
      if (!Number.isInteger(index) || index < 0 || index >= model.frames.length) throw new Error('library-frame-invalid');
      cancelPointers(); animation = null; frameIndex = index; pins = []; activePaths.clear(); rebuildWorld();
    },
    setComparisonMode(mode) {
      if (!['before', 'diff', 'after'].includes(mode)) throw new Error('library-comparison-invalid');
      if (mode === comparisonMode) return; cancelPointers(); animation = null; comparisonMode = mode; rebuildWorld();
    },
    setSelected(id) { selectedId = world.library.nodes.has(id) ? id : null; paintBooks(); requestDraw(); },
    setPalette(id) { const next = normalizeMapPaletteId(id); if (next === paletteId) return; paletteId = next; rebuildWorld(); },
    setPins(nextPins) { pins = (Array.isArray(nextPins) ? nextPins : []).filter(pin => pin.revision === model.frames[frameIndex].revision); activePaths.clear(); paintBooks(); requestDraw(); },
    setActivePins(ids = []) { const selected = new Set(ids); activePaths = new Set(pins.filter(pin => selected.has(pin.id)).map(pin => pin.path)); paintBooks(); requestDraw(); },
    dispose,
  };
}
