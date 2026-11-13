import * as THREE from '/world/vendor/three.module.js';
import { compareRevisionTrees } from './rebuild-model.mjs';
import { buildLibraryOrbitModel, createLibraryOrbitState, normalizeLibraryOrbit, rotateLibraryOrbit,
  zoomLibraryOrbit, orbitCameraPosition, focusLibraryOrbit, libraryOrbitConstraints } from './library-orbit-model.mjs';
import { colorForMapPalette, defaultMapPaletteId, normalizeMapPaletteId } from './map-palette.mjs';
import { buildLibraryGrowth, buildLibraryTransition, sampleLibraryTransition } from './library-growth-model.mjs';
import { revisionLabel } from './rebuild-panel.mjs';
import { buildLibraryArchitecture, sampleLibraryArchitecture } from './library-architecture-model.mjs';

const paper = '#ffffff';
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const fullTurn = Math.PI * 2;
const growthDuration = 1250;
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

function updateArcGeometry(geometry, innerRadius, outerRadius, startAngle, endAngle, height) {
  const steps = 40, positions = geometry.attributes.position; let cursor = 0;
  const point = (radius, angle, y) => [Math.cos(angle) * radius, y, Math.sin(angle) * radius];
  const triangle = (first, second, third) => { for (const vertex of [first, second, third]) positions.setXYZ(cursor++, ...vertex); };
  const quad = (first, second, third, fourth) => { triangle(first, second, third); triangle(first, third, fourth); };
  for (let index = 0; index < steps; index++) {
    const from = startAngle + (endAngle - startAngle) * index / steps, to = startAngle + (endAngle - startAngle) * (index + 1) / steps;
    const innerFrom = point(innerRadius, from, 0), outerFrom = point(outerRadius, from, 0), innerTo = point(innerRadius, to, 0), outerTo = point(outerRadius, to, 0);
    const upperInnerFrom = point(innerRadius, from, height), upperOuterFrom = point(outerRadius, from, height), upperInnerTo = point(innerRadius, to, height), upperOuterTo = point(outerRadius, to, height);
    quad(upperInnerFrom, upperInnerTo, upperOuterTo, upperOuterFrom); quad(innerFrom, outerFrom, outerTo, innerTo);
    quad(outerFrom, upperOuterFrom, upperOuterTo, outerTo); quad(innerTo, upperInnerTo, upperInnerFrom, innerFrom);
  }
  quad(point(innerRadius, startAngle, 0), point(innerRadius, startAngle, height), point(outerRadius, startAngle, height), point(outerRadius, startAngle, 0));
  quad(point(outerRadius, endAngle, 0), point(outerRadius, endAngle, height), point(innerRadius, endAngle, height), point(innerRadius, endAngle, 0));
  positions.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
}
function arcGeometry(innerRadius, outerRadius, startAngle, endAngle, height) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((40 * 24 + 12) * 3), 3));
  updateArcGeometry(geometry, innerRadius, outerRadius, startAngle, endAngle, height); return geometry;
}

function updateLoftGeometry(geometry, contour, height, { radius = 1, waist = 1, twist = 0, inset = 0 } = {}) {
  const positions = geometry.attributes.position, count = contour.length; let cursor = 0;
  const sections = [[0, .97], [.12, 1], [.8, waist], [1, .97 * waist]];
  const point = (index, section) => {
    const [level, width] = sections[section], angle = twist * level, item = contour[index % count];
    const insetScale = Math.max(.1, 1 - inset / Math.max(1, Math.hypot(item.x, item.z)));
    const x = (item.x * Math.cos(angle) - item.z * Math.sin(angle)) * radius * width * insetScale;
    const z = (item.x * Math.sin(angle) + item.z * Math.cos(angle)) * radius * width * insetScale;
    const envelope = Math.min(1, 124 / Math.max(1, Math.hypot(x, z)));
    return [x * envelope, level * height, z * envelope];
  };
  const triangle = (first, second, third) => { for (const vertex of [first, second, third]) positions.setXYZ(cursor++, ...vertex); };
  for (let index = 0; index < count; index++) {
    for (let section = 0; section < sections.length - 1; section++) {
      const a = point(index, section), b = point(index + 1, section), c = point(index + 1, section + 1), d = point(index, section + 1);
      triangle(a, d, c); triangle(a, c, b);
    }
    triangle([0, 0, 0], point(index, 0), point(index + 1, 0));
    triangle([0, height, 0], point(index + 1, 3), point(index, 3));
  }
  positions.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
}
function loftGeometry(contour, height, options) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(contour.length * 24 * 3), 3));
  updateLoftGeometry(geometry, contour, height, options); return geometry;
}
function updateWingGeometry(geometry, start, tip, width, thickness, growth, elevation = 0) {
  const positions = geometry.attributes.position, steps = 24; let cursor = 0;
  const direction = new THREE.Vector3().subVectors(tip, start);
  const lateral = new THREE.Vector3(direction.z, 0, -direction.x).normalize();
  const point = (step, corner) => {
    const progress = step / steps, arch = Math.sin(progress * Math.PI), side = corner & 1 ? 1 : -1, vertical = corner & 2 ? 1 : -1;
    const spread = width * (.65 + .35 * Math.sin(progress * Math.PI));
    return [start.x + direction.x * progress + lateral.x * (arch * 10 * growth + side * spread / 2),
      start.y + direction.y * progress + arch * 13 * growth + vertical * thickness / 2 + elevation,
      start.z + direction.z * progress + lateral.z * (arch * 10 * growth + side * spread / 2)];
  };
  const triangle = (a, b, c) => { for (const vertex of [a, b, c]) positions.setXYZ(cursor++, ...vertex); };
  const quad = (a, b, c, d) => { triangle(a, b, c); triangle(a, c, d); };
  for (let step = 0; step < steps; step++) {
    for (const [a, b] of [[0,1],[1,3],[3,2],[2,0]]) quad(point(step,a),point(step+1,a),point(step+1,b),point(step,b));
  }
  quad(point(0,0),point(0,2),point(0,3),point(0,1));
  quad(point(steps,0),point(steps,1),point(steps,3),point(steps,2));
  positions.needsUpdate = true; geometry.computeVertexNormals(); geometry.computeBoundingSphere();
}
function wingGeometry() {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array((24 * 24 + 12) * 3), 3)); return geometry;
}
function architectureLayers(architecture) { return [architecture?.baseline, ...(architecture?.layers || [])].filter(Boolean); }
function sampleWorldTransition(plan, progress) {
  const sample = sampleLibraryTransition(plan, progress);
  sample.architecture = sampleLibraryArchitecture(plan.from?.architecture, plan.to.architecture, progress); return sample;
}

export function createLibraryOrbitScene({ canvas, model, initialFrameIndex = 0, onSelect = () => {},
  onNavigate = () => {}, onHover = () => {}, onChange = () => {}, onError = () => {}, onRecordSelect = () => {}, onRecordGroup = () => {}, onLayerSelect = () => {} }) {
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
  const transitionLabel = document.createElement('div'); transitionLabel.className = 'library-transition-label'; transitionLabel.hidden = true;
  transitionLabel.setAttribute('role', 'status'); surface.append(transitionLabel);
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const raycaster = new THREE.Raycaster(), rayPoint = new THREE.Vector2(), projected = new THREE.Vector3();
  const temporary = new THREE.Object3D(), color = new THREE.Color();
  let frameIndex = initialFrameIndex, comparisonMode = 'diff', paletteId = defaultMapPaletteId;
  let world, displayedWorld, comparison, orbit, worldGroup = new THREE.Group(), towerGroup, platformGroup, bookMesh, bookPages, bookBands, ghostBooks, pickables = [];
  let transition = null, transitionStarted = 0, transitionFrom = '', transitionTo = '', outlineMesh;
  let shelfVisuals = new Map(), layerVisuals = new Map(), branchVisuals = new Map(), ghostIds = [], annotationGroup;
  let selectedId = null, hoveredId = null, hoveredAnnotation = null, focusedId = '', pins = [], activePaths = new Set();
  let width = 1, height = 1, pixelRatio = 1, viewport = { left: 0, top: 0, right: 1, bottom: 1 };
  let requestedViewport = null, hasViewport = false, animation = null;
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
  function buildBooks(ivory, sample) {
    const count = world.books.length, box = new THREE.BoxGeometry(1, 1, 1);
    bookMesh = new THREE.InstancedMesh(box, material('#ffffff', { roughness: .58 }), count);
    bookPages = new THREE.InstancedMesh(box, ivory, count);
    bookBands = new THREE.InstancedMesh(box, material('#ffffff', { metalness: .3, roughness: .45 }), count);
    for (const mesh of [bookMesh, bookPages, bookBands]) { mesh.castShadow = true; mesh.receiveShadow = true; worldGroup.add(mesh); }
    bookMesh.userData.bookInstances = true; pickables.push(bookMesh);
    const targetIds = new Set(world.books.map(book => book.id));
    ghostIds = sample.books.filter(book => !targetIds.has(book.id)).map(book => book.id);
    ghostBooks = new THREE.InstancedMesh(box, material('#a9b3bc', { transparent: true, opacity: .34, depthWrite: false }), ghostIds.length);
    ghostBooks.userData.ghost = true; worldGroup.add(ghostBooks); pickables.push(ghostBooks);
    const outline = new THREE.BufferGeometry();
    outline.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(count * 24 * 3), 3));
    outline.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(count * 24 * 3), 3));
    outlineMesh = new THREE.LineSegments(outline, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: .72 }));
    outlineMesh.frustumCulled = false; worldGroup.add(outlineMesh); paintBooks();
  }
  function writeBookInstance(mesh, index, book, part = 'body') {
    const { position, size, yaw } = book;
    const visible = size.height > .01 && (book.opacity ?? 1) > .001;
    temporary.position.set(position.x, position.y, position.z); temporary.rotation.set(0, yaw, 0);
    temporary.scale.set(Math.max(.001, size.width), Math.max(.001, size.height), Math.max(.001, size.depth));
    if (part === 'pages') {
      temporary.position.y += size.height * .5 + .1; temporary.scale.set(size.width * .74, .45, size.depth * .85);
    } else if (part === 'band') {
      temporary.position.x += Math.sin(yaw) * (size.depth / 2 + .15); temporary.position.y += size.height * .24;
      temporary.position.z += Math.cos(yaw) * (size.depth / 2 + .15); temporary.scale.set(size.width * .74, 1.1, .5);
    }
    if (!visible) temporary.scale.setScalar(.00001);
    temporary.updateMatrix(); mesh.setMatrixAt(index, temporary.matrix);
  }
  function paintBookTransforms(sample) {
    const byId = new Map(sample.books.map(book => [book.id, book]));
    const vertices = outlineMesh.geometry.attributes.position, colors = outlineMesh.geometry.attributes.color;
    const edges = [[0,1],[1,3],[3,2],[2,0],[4,5],[5,7],[7,6],[6,4],[0,4],[1,5],[2,6],[3,7]];
    let cursor = 0;
    world.books.forEach((target, index) => {
      const book = byId.get(target.id) || { ...target, size: { ...target.size, height: 0 }, opacity: 0 };
      writeBookInstance(bookMesh, index, book); writeBookInstance(bookPages, index, book, 'pages'); writeBookInstance(bookBands, index, book, 'band');
      const change = comparisonMode === 'diff' ? comparison.changes.find(item => item.path === target.id) : null;
      const status = transition ? book.status : change?.status;
      const outlined = ['added', 'modified'].includes(status) && book.size.height > .1;
      color.set(status === 'added' ? '#c9913d' : '#5b8396');
      const expansion = 1.04 + (book.pulse || 0) * .1;
      temporary.position.set(book.position.x, book.position.y, book.position.z); temporary.rotation.set(0, book.yaw, 0);
      temporary.scale.set(book.size.width * expansion, book.size.height * expansion, book.size.depth * expansion); temporary.updateMatrix();
      const corners = Array.from({ length: 8 }, (_, corner) => new THREE.Vector3(corner & 1 ? .5 : -.5, corner & 2 ? .5 : -.5, corner & 4 ? .5 : -.5).applyMatrix4(temporary.matrix));
      for (const edge of edges) for (const corner of edge) {
        const point = outlined ? corners[corner] : corners[0]; vertices.setXYZ(cursor, point.x, point.y, point.z); colors.setXYZ(cursor++, color.r, color.g, color.b);
      }
    });
    ghostIds.forEach((id, index) => {
      const book = byId.get(id);
      if (book) writeBookInstance(ghostBooks, index, book);
      else { temporary.scale.setScalar(.00001); temporary.updateMatrix(); ghostBooks.setMatrixAt(index, temporary.matrix); }
    });
    for (const mesh of [bookMesh, bookPages, bookBands, ghostBooks]) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
    ghostBooks.visible = sample.books.some(book => ghostIds.includes(book.id) && book.size.height > .01);
    vertices.needsUpdate = colors.needsUpdate = true;
  }
  function layerColor(layer) {
    return nodeColor({ id: layer.category || 'apps', path: layer.category || 'apps', type: 'folder', fileCount: 1 });
  }
  function buildTower(ivory, sample) {
    towerGroup = new THREE.Group(); worldGroup.add(towerGroup); layerVisuals.clear();
    for (const layer of architectureLayers(sample.architecture)) {
      const group = new THREE.Group(); towerGroup.add(group);
      const glass = new THREE.Color(layerColor(layer)).lerp(new THREE.Color('#314e5b'), .42);
      const floor = addMesh(group, loftGeometry(layer.contour, .7), ivory);
      const body = addMesh(group, loftGeometry(layer.contour, Math.max(.001, layer.height - 1.2), { inset: layer.inset * .5 }), material(glass, { roughness: .32, metalness: .12 }));
      const roof = addMesh(group, loftGeometry(layer.contour, .5), ivory);
      for (const mesh of [floor, body, roof]) { mesh.userData.annotation = { kind: 'layer', id: layer.id }; pickables.push(mesh); }
      layerVisuals.set(layer.id, { group, floor, body, roof });
    }
  }
  function buildShelves(ivory, sample) {
    shelfVisuals.clear();
    for (const shelf of sample.shelves) {
      const shelfId = world.library.nodes.has(shelf.sector) ? shelf.sector : '';
      const group = new THREE.Group(); worldGroup.add(group);
      const floor = addMesh(group, arcGeometry(shelf.innerRadius - 2, shelf.outerRadius + 2, shelf.startAngle, shelf.endAngle, 4), ivory, null, shelfId);
      const roof = addMesh(group, arcGeometry(shelf.innerRadius - 2, shelf.outerRadius + 2, shelf.startAngle, shelf.endAngle, 2.4), ivory, null, shelfId);
      const posts = [0, 1].map(() => addMesh(group, new THREE.BoxGeometry(1, 1, 1), ivory, null, shelfId));
      shelfVisuals.set(shelf.id, { group, floor, roof, posts });
    }
  }
  function createGrowthWorld(frame) {
    const next = buildLibraryOrbitModel(frame);
    next.architecture = buildLibraryArchitecture(model.architectureHistory, frame.revision);
    const architecture = next.architecture, known = architecture.status === 'ready';
    next.tower = { ...next.tower, height: known ? architecture.height : 0, radius: known ? architecture.radius : 0, levels: architecture.layers.length, tiers: [] };
    next.target = { x: 0, y: next.tower.height * .4, z: 0 };
    next.growth = buildLibraryGrowth(frame, { world: next }); return next;
  }
  function buildAnnotations(sample) {
    annotationGroup = new THREE.Group(); worldGroup.add(annotationGroup); branchVisuals.clear();
    for (const branch of sample.growth.branches) {
      const group = new THREE.Group(); annotationGroup.add(group);
      const wing = addMesh(group, wingGeometry(), material('#f7fbfc', { roughness: .55, side: THREE.DoubleSide }));
      const glass = addMesh(group, wingGeometry(), material('#80b1d3', { metalness: .15, roughness: .3, side: THREE.DoubleSide }));
      for (const mesh of [wing, glass]) { mesh.userData.annotation = { kind: 'branch', id: branch.id }; pickables.push(mesh); }
      branchVisuals.set(branch.id, { group, wing, glass });
    }
  }
  function applyWorldSample(sample) {
    displayedWorld = sample; platformGroup.scale.set(sample.radius / world.radius, 1, sample.radius / world.radius);
    paintBookTransforms(sample);
    const shelvesById = new Map(sample.shelves.map(shelf => [shelf.id, shelf]));
    for (const [id, visual] of shelfVisuals) {
      const shelf = shelvesById.get(id); visual.group.visible = !!shelf && (shelf.scale ?? 1) > .001;
      if (!shelf) continue; const growth = shelf.scale ?? 1;
      visual.group.position.y = shelf.baseY; visual.group.scale.y = Math.max(.001, growth);
      for (const [mesh, thickness] of [[visual.floor, 4], [visual.roof, 2.4]]) updateArcGeometry(mesh.geometry, shelf.innerRadius - 2, shelf.outerRadius + 2, shelf.startAngle, shelf.endAngle, thickness);
      visual.roof.position.y = shelf.height;
      visual.posts.forEach((post, index) => {
        const angle = index ? shelf.endAngle : shelf.startAngle, radius = (shelf.innerRadius + shelf.outerRadius) / 2;
        post.position.set(Math.cos(angle) * radius, shelf.height / 2, Math.sin(angle) * radius);
        post.rotation.y = Math.PI / 2 - angle; post.scale.set(2.7, shelf.height, shelf.outerRadius - shelf.innerRadius + 4);
      });
    }
    const layers = new Map(architectureLayers(sample.architecture).map(layer => [layer.id, layer]));
    for (const [id, visual] of layerVisuals) {
      const layer = layers.get(id); visual.group.visible = !!layer && (layer.scale ?? 1) > .001;
      if (!layer) continue;
      const changed = (layer.changes?.added || 0) + (layer.changes?.modified || 0) + (layer.changes?.deleted || 0);
      const signature = Number.parseInt(layer.changeFingerprint || '0', 16) >>> 0;
      const addedShare = changed ? (layer.changes.added || 0) / changed : 0, deletedShare = changed ? (layer.changes.deleted || 0) / changed : 0;
      const waist = clamp(.70 + (signature & 65535) / 65535 * .4 + (addedShare - deletedShare) * .06, .70, 1.10);
      const twist = ((signature >>> 16) / 65535 * 2 - 1) * .18;
      visual.group.position.y = layer.y;
      const floorHeight = Math.min(.7, layer.height * .22), roofHeight = Math.min(.5, layer.height * .15);
      const bodyHeight = Math.max(.001, layer.height - floorHeight - roofHeight);
      updateLoftGeometry(visual.floor.geometry, layer.contour, floorHeight);
      updateLoftGeometry(visual.body.geometry, layer.contour, bodyHeight, { inset: (layer.inset || 5) * .5, waist, twist });
      updateLoftGeometry(visual.roof.geometry, layer.contour, roofHeight, { radius: Math.min(1, waist + .04), twist });
      visual.body.position.y = floorHeight; visual.roof.position.y = layer.height - roofHeight;
    }
    const branches = new Map(sample.growth.branches.map(item => [item.id, item]));
    for (const [id, visual] of branchVisuals) {
      const item = branches.get(id); visual.group.visible = !!item && (item.scale ?? 1) > .001;
      if (!item) continue;
      const layer = architectureLayers(sample.architecture).filter(candidate => candidate.recordPaths?.includes(item.sourcePath)).at(-1);
      const offset = layer ? layer.y + layer.height * .45 - item.position.y : 0;
      const start = new THREE.Vector3(item.position.x, item.position.y + offset, item.position.z), tip = new THREE.Vector3(item.tip.x, item.tip.y + offset, item.tip.z);
      const growth = Math.max(.001, item.scale ?? 1); tip.lerpVectors(start, tip, growth);
      updateWingGeometry(visual.wing.geometry, start, tip, 13 * growth, 2.4, growth);
      updateWingGeometry(visual.glass.geometry, start, tip, 8 * growth, .7, growth, 1.7);
      visual.anchor = { x: tip.x, y: tip.y + 8, z: tip.z };
    }
    worldGroup.updateMatrixWorld(true);
  }
  function rebuildWorld({ animate = true } = {}) {
    const previous = displayedWorld || world, ongoing = transition, wasAnimating = !!ongoing;
    const before = frameIndex > 0 ? model.frames[frameIndex - 1] : null;
    comparison = compareRevisionTrees(before, model.frames[frameIndex]);
    world = createGrowthWorld(comparisonMode === 'before' && before ? before : model.frames[frameIndex]);
    const shouldAnimate = animate && !reducedMotion && previous && (previous.revision !== world.revision || wasAnimating);
    const resume = shouldAnimate && ongoing?.to.revision === world.revision;
    const plan = resume ? { ...ongoing, to: world } : buildLibraryTransition(previous, world);
    transition = shouldAnimate ? plan : null; if (!resume) transitionStarted = performance.now();
    const fromRevision = transition ? plan.comparison.fromRevision : previous?.revision;
    transitionFrom = fromRevision ? revisionLabel(model.frames.find(frame => frame.revision === fromRevision)) : '';
    transitionTo = revisionLabel(model.frames.find(frame => frame.revision === world.revision));
    transitionLabel.textContent = `${transitionFrom} → ${transitionTo}`; transitionLabel.hidden = !transition;
    const progress = resume ? clamp((performance.now() - transitionStarted) / growthDuration, 0, 1) : 0;
    const sample = transition ? sampleWorldTransition(plan, progress) : world;
    if (selectedId !== null && !world.library.nodes.has(selectedId)) selectedId = null;
    if (!world.library.nodes.has(focusedId)) focusedId = '';
    disposeGroup(worldGroup); pickables = [];
    const ivory = material('#fffdfa', { roughness: .48, metalness: .02 });
    platformGroup = new THREE.Group(); worldGroup.add(platformGroup);
    const shadow = addMesh(platformGroup, new THREE.PlaneGeometry(world.radius * 3, world.radius * 3), new THREE.ShadowMaterial({ color: '#80939a', opacity: .1, depthWrite: false }), { y: -.3 }, undefined, false);
    shadow.rotation.x = -Math.PI / 2;
    buildShelves(ivory, sample); buildBooks(ivory, sample); buildTower(ivory, sample); buildAnnotations(sample); applyWorldSample(sample);
    sunlight.shadow.camera.left = sunlight.shadow.camera.bottom = -world.radius - 100;
    sunlight.shadow.camera.right = sunlight.shadow.camera.top = world.radius + 100;
    sunlight.shadow.camera.far = 1600; sunlight.shadow.camera.updateProjectionMatrix();
    orbit = orbit ? normalizeLibraryOrbit(orbit, sample) : createLibraryOrbitState(world, { aspect: viewportAspect() });
    hoveredAnnotation = null; setHovered(null); requestDraw();
  }
  function refreshRecords() {
    if (disposed || failed) return;
    const targetFrame = model.frames.find(frame => frame.revision === world.revision);
    if (!targetFrame) return;
    const previous = displayedWorld, growth = buildLibraryGrowth(targetFrame, { world }); world = { ...world, growth };
    if (transition) {
      const recordsPlan = buildLibraryTransition(transition.from, world);
      transition = { ...transition, to: world, ornaments: recordsPlan.ornaments, branches: recordsPlan.branches };
    } else if (!reducedMotion) {
      const recordsPlan = buildLibraryTransition(previous, world);
      if (recordsPlan.ornaments.some(pair => pair.status !== 'unchanged') || recordsPlan.branches.some(pair => !pair.before || !pair.after)) {
        transition = recordsPlan; transitionStarted = performance.now();
      }
    }
    const sample = transition ? sampleWorldTransition(transition, clamp((performance.now() - transitionStarted) / growthDuration, 0, 1)) : world;
    pickables = pickables.filter(mesh => mesh.userData.annotation?.kind !== 'branch');
    disposeGroup(annotationGroup); worldGroup.remove(annotationGroup); buildAnnotations(sample); applyWorldSample(sample); requestDraw();
  }
  function viewportAspect() { return Math.max(.25, (viewport.right - viewport.left) / Math.max(1, viewport.bottom - viewport.top)); }
  function viewportUsable() { return viewport.right - viewport.left > 16 && viewport.bottom - viewport.top > 16; }
  function updateCamera() {
    const shown = displayedWorld || world, position = orbitCameraPosition(orbit, shown);
    camera.position.set(position.x, position.y, position.z); camera.lookAt(shown.target.x, shown.target.y, shown.target.z);
    camera.aspect = viewportAspect(); camera.updateProjectionMatrix(); camera.updateMatrixWorld();
  }
  function badgeFor(id) {
    if (comparisonMode !== 'diff' || comparison.status !== 'measured') return '';
    const group = comparison.groups.get(id);
    if (group) return [['+', group.added], ['~', group.modified], ['−', group.deleted]].filter(([, count]) => count).map(([mark, count]) => `${mark}${count}`).join(' ');
    const change = comparison.changes.find(item => item.path === id);
    return change ? change.status === 'added' ? '+' : change.status === 'modified' ? '~' : '−' : '';
  }
  function projectPosition(position) {
    projected.set(position.x, position.y, position.z).project(camera);
    if (projected.z < -1 || projected.z > 1) return null;
    return { x: viewport.left + (projected.x + 1) / 2 * (viewport.right - viewport.left),
      y: viewport.top + (1 - projected.y) / 2 * (viewport.bottom - viewport.top) };
  }
  function projectLabel(node) {
    const shown = displayedWorld || world;
    if (!node.id) return projectPosition({ x: 0, y: shown.tower.height + 34, z: 0 });
    if (node.type === 'file') {
      const book = shown.books.find(item => item.id === node.id);
      if (book && book.size.height > .5) return projectPosition({ ...book.position, y: book.position.y + book.size.height / 2 + 15 });
      return null;
    }
    const shelf = shown.shelves.find(item => item.sector === node.id && (item.scale ?? 1) > .1);
    if (shelf) {
      const angle = (shelf.startAngle + shelf.endAngle) / 2, radius = (shelf.innerRadius + shelf.outerRadius) / 2;
      return projectPosition({ x: Math.cos(angle) * radius, y: 58, z: Math.sin(angle) * radius });
    }
    return projectPosition({ x: node.center.x, y: 58, z: node.center.y });
  }
  function paintLabels() {
    const occupied = [], visible = new Set();
    paintRecordLabels(occupied, visible);
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
  function paintRecordLabels(occupied, visible) {
    const shown = displayedWorld || world, layers = architectureLayers(shown.architecture);
    const current = layers.find(layer => layer.revision === world.revision);
    const hovered = hoveredAnnotation?.kind === 'layer' ? layers.find(layer => layer.id === hoveredAnnotation.id) : null;
    const candidates = [current, hovered].filter(Boolean);
    for (const layer of candidates) {
      if (layer.selectable === false || (layer.scale ?? 1) < .2) continue;
      const key = `layer:${layer.id}`; if (visible.has(key)) continue;
      const edge = [...layer.contour].sort((a, b) => (b.x * camera.position.x + b.z * camera.position.z) - (a.x * camera.position.x + a.z * camera.position.z))[0];
      const point = projectPosition({ x: edge.x, y: layer.y + layer.height + 6, z: edge.z }); if (!point) continue;
      const name = layer.prNumber ? `PR #${layer.prNumber}` : `Git ${layer.revision.slice(0, 7)}`;
      const labelWidth = clamp(name.length * 6.5 + 12, 48, 130);
      const box = { left: point.x - labelWidth / 2, right: point.x + labelWidth / 2, top: point.y - 27, bottom: point.y };
      if (box.left < viewport.left || box.right > viewport.right || box.top < viewport.top || box.bottom > viewport.bottom || occupied.some(other => overlaps(box, other))) continue;
      occupied.push(box); visible.add(key);
      let label = labels.get(key);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'library-orbit-label library-orbit-record-label';
        label.dataset.annotationId = layer.id; label.dataset.annotationKind = 'layer';
        const title = document.createElement('span'); label.append(title);
        label.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) activateAnnotation({ id: label.dataset.annotationId, kind: 'layer' }); });
        labelHost.append(label); labels.set(key, label);
      }
      label.firstChild.textContent = name; label.setAttribute('aria-label', name);
      label.setAttribute('aria-current', String(layer.revision === world.revision));
      Object.assign(label.style, { display: 'grid', left: `${box.left}px`, top: `${box.top}px`, width: `${labelWidth}px` });
    }
    for (const branch of shown.growth.branches) {
      if (branch.selectable === false || (branch.scale ?? 1) < .4) continue;
      const anchor = branchVisuals.get(branch.id)?.anchor, point = anchor ? projectPosition(anchor) : null;
      if (!point) continue;
      const key = `bridge:${branch.id}`, box = { left: point.x - 24, right: point.x + 24, top: point.y - 26, bottom: point.y };
      if (box.left < viewport.left || box.right > viewport.right || box.top < viewport.top || box.bottom > viewport.bottom || occupied.some(other => overlaps(box, other))) continue;
      occupied.push(box); visible.add(key); let label = labels.get(key);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'library-orbit-label library-orbit-record-label';
        label.dataset.annotationId = branch.id; label.dataset.annotationKind = 'branch'; label.textContent = 'ADR';
        label.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) activateAnnotation({ id: label.dataset.annotationId, kind: 'branch' }); });
        labelHost.append(label); labels.set(key, label);
      }
      label.setAttribute('aria-label', branch.label || branch.sourcePath);
      Object.assign(label.style, { display: 'grid', left: `${box.left}px`, top: `${box.top}px`, width: '48px' });
    }
  }
  function reportState() {
    const constraints = libraryOrbitConstraints(world, { aspect: viewportAspect() });
    const state = { renderer: 'webgl', regionId: focusedId, zoom: constraints.fitDistance / orbit.distance, frameIndex,
      comparisonMode, comparisonStatus: comparison.status, displayRevision: world.library.revision, paletteId,
      growth: world.growth.coverage, architecture: { status: world.architecture.status, count: world.architecture.layers.length, coverage: world.architecture.coverage }, branches: world.growth.branches.length,
      transition: { active: !!transition, fromRevision: transition?.comparison.fromRevision ?? null, toRevision: world.revision, progress: transition ? displayedWorld.transition?.progress ?? 0 : 1 },
      books: world.books.length, towerLevels: world.tower.levels, towerHeight: world.tower.height,
      orbit: { yaw: orbit.yaw, pitch: orbit.pitch, distance: orbit.distance }, pins: { aggregation: 'folders', total: pins.length } };
    const signature = JSON.stringify(state); if (signature !== lastState) { lastState = signature; onChange(state); }
  }
  function fail(error) {
    if (disposed || failed) return; failed = true; cancelPointers(); animation = transition = null; transitionLabel.hidden = true; canvas.setAttribute('aria-busy', 'false');
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
      if (transition) {
        const progress = clamp((now - transitionStarted) / growthDuration, 0, 1);
        applyWorldSample(sampleWorldTransition(transition, progress));
        if (progress === 1) { transition = null; transitionLabel.hidden = true; rebuildWorld({ animate: false }); }
      }
      canvas.setAttribute('aria-busy', String(!!transition));
      canvas.dataset.transitionFrom = transition?.comparison.fromRevision || '';
      canvas.dataset.transitionTo = world.revision;
      canvas.dataset.transitionProgress = String(transition ? displayedWorld.transition.progress : 1);
      transitionLabel.style.left = `${(viewport.left + viewport.right) / 2}px`; transitionLabel.style.top = `${viewport.top + 6}px`;
      renderer.setScissorTest(false); renderer.setViewport(0, 0, width, height); renderer.clear();
      if (viewportUsable()) {
        updateCamera(); renderer.setViewport(viewport.left, height - viewport.bottom, viewport.right - viewport.left, viewport.bottom - viewport.top);
        renderer.setScissor(viewport.left, height - viewport.bottom, viewport.right - viewport.left, viewport.bottom - viewport.top);
        renderer.setScissorTest(true); renderer.render(scene, camera); paintLabels();
      } else for (const label of labels.values()) label.style.display = 'none';
      reportState();
    } catch (error) { fail(error); }
    if (animation || transition) requestDraw();
  }
  function select(id) { if (!failed && world.library.nodes.has(id)) { selectedId = id; paintBooks(); requestDraw(); onSelect(id); } }
  function setHovered(id, point = null) {
    if (id === null && hoveredAnnotation) { hoveredAnnotation = null; requestDraw(); }
    if (hoveredId === id) return; hoveredId = id; canvas.style.cursor = id === null ? 'grab' : 'pointer';
    paintBooks(); onHover(id, point); requestDraw();
  }
  function activateAnnotation(annotation) {
    if (!annotation || failed || disposed) return;
    if (annotation.kind === 'layer') {
      const layer = architectureLayers(world.architecture).find(item => item.id === annotation.id);
      if (layer) onLayerSelect({ revision: layer.revision, pr: layer.prNumber, changes: layer.changes, recordPaths: layer.recordPaths });
      return;
    }
    if (annotation.kind === 'branch') {
      const branch = world.growth.branches.find(item => item.id === annotation.id);
      if (branch) onRecordSelect({ revision: world.revision, path: branch.sourcePath, proof: branch.proof, targetPath: branch.targetPath });
      return;
    }
    const ornament = world.growth.ornaments.find(item => item.id === annotation.id);
    if (!ornament) return;
    if (ornament.records.length === 1) onRecordSelect({ revision: world.revision, path: ornament.records[0].path });
    else onRecordGroup({ revision: world.revision, records: ornament.records, kind: ornament.kind });
  }
  function activatePick(result) { if (typeof result === 'string') select(result); else if (result) activateAnnotation(result); }
  function hoverPick(result, point) {
    const annotation = typeof result === 'object' && result ? result : null;
    const changed = hoveredAnnotation?.id !== annotation?.id;
    setHovered(typeof result === 'string' ? result : null, point); hoveredAnnotation = annotation;
    if (changed) requestDraw(); if (annotation) canvas.style.cursor = 'pointer';
  }
  function labelPick(target) {
    const label = target.closest?.('.library-orbit-label');
    if (label?.dataset.annotationId) return { id: label.dataset.annotationId, kind: label.dataset.annotationKind };
    return label?.dataset.nodeId;
  }
  function pick(point) {
    if (!viewportUsable() || point.x < viewport.left || point.x > viewport.right || point.y < viewport.top || point.y > viewport.bottom) return null;
    rayPoint.set((point.x - viewport.left) / (viewport.right - viewport.left) * 2 - 1, 1 - (point.y - viewport.top) / (viewport.bottom - viewport.top) * 2);
    raycaster.setFromCamera(rayPoint, camera);
    const visible = pickables.filter(mesh => { for (let ancestor = mesh; ancestor; ancestor = ancestor.parent) if (!ancestor.visible) return false; return true; });
    const hit = raycaster.intersectObjects(visible, false)[0];
    if (!hit || hit.object.userData.ghost) return null;
    const annotation = hit.object.userData.annotation;
    if (annotation) {
      const collection = annotation.kind === 'layer' ? architectureLayers(displayedWorld.architecture) : displayedWorld.growth.branches;
      const item = collection.find(entry => entry.id === annotation.id);
      return item && item.selectable !== false ? annotation : null;
    }
    if (hit.object.userData.bookInstances) {
      const id = world.books[hit.instanceId]?.id, book = displayedWorld.books.find(item => item.id === id);
      return book && book.selectable !== false && book.size.height > .5 ? id : null;
    }
    return world.library.nodes.has(hit.object.userData.nodeId) ? hit.object.userData.nodeId : null;
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
    pointers.set(event.pointerId, { point, start: point, dragged: false, multiple: pointers.size > 0, labelPick: labelPick(event.target) });
    if (pointers.size > 1) for (const pointer of pointers.values()) pointer.multiple = true;
    canvas.setPointerCapture(event.pointerId); canvas.focus(); canvas.style.cursor = 'grabbing';
  });
  listen(surface, 'pointermove', event => {
    if (failed) return; const point = eventPoint(event), pointer = pointers.get(event.pointerId);
    if (!pointer) { if (isMapPointer(event) && event.pointerType !== 'touch') hoverPick(labelPick(event.target) ?? pick(point), point); return; }
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
      activatePick(pointer.labelPick ?? pick(eventPoint(event)));
    }
    canvas.style.cursor = pointers.size ? 'grabbing' : 'grab';
  });
  listen(surface, 'pointercancel', () => { cancelPointers(); setHovered(null); });
  listen(canvas, 'lostpointercapture', event => { if (pointers.has(event.pointerId)) cancelPointers(); });
  listen(surface, 'pointerleave', () => { if (!pointers.size) setHovered(null); });
  listen(surface, 'dblclick', event => {
    if (failed || !isMapPointer(event)) return; const id = labelPick(event.target) ?? pick(eventPoint(event));
    if (typeof id === 'string') { event.preventDefault(); selectedId = id; focus(id); onNavigate(id); }
  });
  listen(canvas, 'keydown', event => {
    if (failed || !['+', '=', '-', 'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === '+' || event.key === '=') zoom(1.25); else if (event.key === '-') zoom(.8);
    else if (event.key === 'Home') { focus(''); onNavigate(''); }
    else rotate(({ ArrowLeft: .16, ArrowRight: -.16 })[event.key] || 0, ({ ArrowUp: .09, ArrowDown: -.09 })[event.key] || 0);
  });
  function dispose() {
    if (disposed) return; disposed = true; cancelPointers(); animation = transition = null; transitionLabel.hidden = true; canvas.setAttribute('aria-busy', 'false');
    if (drawRequest !== null) cancelAnimationFrame(drawRequest); observer?.disconnect();
    for (const remove of listeners) remove(); labelHost.remove(); transitionLabel.remove(); labels.clear();
    disposeGroup(worldGroup); sunlight.shadow.map?.dispose(); renderer.dispose(); canvas.classList.remove('library-orbit-canvas');
  }
  try { rebuildWorld(); resize(); observer = new ResizeObserver(resize); observer.observe(canvas); }
  catch (error) { dispose(); throw error; }
  return {
    focus, home: () => focus(''), zoom, resize, refreshRecords, setPinViewport, setViewport: setPinViewport,
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
