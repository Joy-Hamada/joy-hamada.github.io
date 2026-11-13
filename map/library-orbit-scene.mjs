import * as THREE from '/world/vendor/three.module.js';
import { compareRevisionTrees } from './rebuild-model.mjs';
import { buildLibraryOrbitModel, createLibraryOrbitState, normalizeLibraryOrbit, rotateLibraryOrbit,
  zoomLibraryOrbit, orbitCameraPosition, focusLibraryOrbit, libraryOrbitConstraints } from './library-orbit-model.mjs';
import { colorForMapPalette, defaultMapPaletteId, normalizeMapPaletteId } from './map-palette.mjs';
import { buildLibraryGrowth, buildLibraryTransition, sampleLibraryTransition } from './library-growth-model.mjs';
import { revisionLabel } from './rebuild-panel.mjs';

const paper = '#fffefb';
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

export function createLibraryOrbitScene({ canvas, model, initialFrameIndex = 0, onSelect = () => {},
  onNavigate = () => {}, onHover = () => {}, onChange = () => {}, onError = () => {}, onRecordSelect = () => {}, onRecordGroup = () => {} }) {
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
  let world, displayedWorld, comparison, orbit, worldGroup = new THREE.Group(), towerGroup, platformGroup, crownGroup, bookMesh, bookPages, bookBands, ghostBooks, pickables = [];
  let transition = null, transitionStarted = 0, transitionFrom = '', transitionTo = '', outlineMesh;
  let shelfVisuals = new Map(), tierVisuals = new Map(), ornamentVisuals = new Map(), branchVisuals = new Map(), ghostIds = [], annotationGroup;
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
  function buildTower(ivory, trim, sample) {
    towerGroup = new THREE.Group(); worldGroup.add(towerGroup); tierVisuals.clear();
    const tower = world.tower, baseRadius = tower.radius;
    addMesh(towerGroup, new THREE.CylinderGeometry(baseRadius + 18, baseRadius + 23, 5, 80), ivory, { y: 3 }, '');
    addMesh(towerGroup, new THREE.CylinderGeometry(baseRadius + 11, baseRadius + 16, 8, 80), ivory, { y: 9 }, '');
    const palette = world.library.landmarks.map(node => nodeColor(node));
    if (!palette.length) palette.push('#8dd3c7', '#bebada', '#fdb462');
    sample.tower.tiers.forEach((sampleTier, index) => {
      const tier = world.tower.tiers[index] || sampleTier, group = new THREE.Group(); towerGroup.add(group);
      tierVisuals.set(String(index), { group, tier });
      const tint = material(palette[index % palette.length], { roughness: .48, metalness: .12 });
      addMesh(group, new THREE.CylinderGeometry(tier.topRadius * .7, tier.bottomRadius * .68, tier.height, 48), ivory, { y: tier.height / 2 }, '');
      const eaveY = tier.height * .84;
      addMesh(group, new THREE.CylinderGeometry(tier.topRadius * .35, tier.bottomRadius + 5, tier.height * .3, 64), ivory, { y: eaveY }, '');
      addMesh(group, new THREE.CylinderGeometry(tier.bottomRadius + 5, tier.bottomRadius + 5, 2.4, 64), tint, { y: eaveY - tier.height * .15 }, '');
      const ring = addMesh(group, new THREE.TorusGeometry(tier.bottomRadius * .67, 1.3, 6, 64), trim, { y: 3 }, ''); ring.rotation.x = Math.PI / 2;
      for (let spoke = 0; spoke < 8; spoke++) {
        const angle = spoke / 8 * fullTurn, radius = tier.bottomRadius * .58;
        addMesh(group, new THREE.CylinderGeometry(1.35, 1.65, tier.height * .53, 6), trim,
          { x: Math.cos(angle) * radius, y: tier.height * .28, z: Math.sin(angle) * radius }, '');
      }
    });
    crownGroup = new THREE.Group(); towerGroup.add(crownGroup);
    addMesh(crownGroup, new THREE.ConeGeometry(12, 30, 48), ivory, { y: -15 }, '');
    addMesh(crownGroup, new THREE.SphereGeometry(3.3, 16, 12), trim, { y: 3 }, '');
    const halo = addMesh(crownGroup, new THREE.TorusGeometry(17, .8, 6, 56), trim, { y: -20 }, ''); halo.rotation.x = Math.PI / 2;
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
    const next = buildLibraryOrbitModel(frame); next.growth = buildLibraryGrowth(frame, { world: next }); return next;
  }
  function buildAnnotations(sample) {
    annotationGroup = new THREE.Group(); worldGroup.add(annotationGroup); ornamentVisuals.clear(); branchVisuals.clear();
    const colors = { issue: '#8dd3c7', sdd: '#bebada', adr: '#fdb462' };
    for (const ornament of sample.growth.ornaments) {
      const group = new THREE.Group(); annotationGroup.add(group);
      const radius = 4.6 + Math.min(4, Math.log2(ornament.count + 1));
      const geometry = ornament.kind === 'sdd' ? new THREE.OctahedronGeometry(radius) : new THREE.SphereGeometry(radius, 16, 12);
      const jewel = addMesh(group, geometry, material(colors[ornament.kind], { metalness: .3, roughness: .22 }), null);
      const cap = addMesh(group, new THREE.CylinderGeometry(1.8, 2.5, 2, 8), material('#cfbd94', { metalness: .65 }), { y: radius + 1 });
      for (const mesh of [jewel, cap]) { mesh.userData.annotation = { kind: 'ornament', id: ornament.id }; pickables.push(mesh); }
      const thread = addMesh(group, new THREE.CylinderGeometry(.35, .35, 9, 5), material('#d6c9ac'), { y: radius + 6 });
      const halo = addMesh(group, new THREE.TorusGeometry(radius + 2, .45, 5, 24), material('#fff2bf', { transparent: true, opacity: 0, depthWrite: false }), null, undefined, false);
      ornamentVisuals.set(ornament.id, { group, jewel, thread, halo });
    }
    for (const branch of sample.growth.branches) {
      const group = new THREE.Group(); annotationGroup.add(group);
      const stem = addMesh(group, new THREE.CylinderGeometry(1.2, 2, 1, 8), material('#c9b588', { metalness: .4 }), null);
      const gem = addMesh(group, new THREE.OctahedronGeometry(6.5), material('#80b1d3', { metalness: .2, roughness: .28 }), null);
      for (const mesh of [stem, gem]) { mesh.userData.annotation = { kind: 'branch', id: branch.id }; pickables.push(mesh); }
      branchVisuals.set(branch.id, { group, stem, gem });
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
    const tiers = new Map(sample.tower.tiers.map((tier, index) => [String(index), tier]));
    for (const [id, visual] of tierVisuals) {
      const tier = tiers.get(id); visual.group.visible = !!tier && (tier.scale ?? 1) > .001;
      if (!tier) continue; const growth = tier.scale ?? 1;
      visual.group.position.y = tier.y; visual.group.scale.set(Math.max(.001, growth * tier.bottomRadius / visual.tier.bottomRadius), Math.max(.001, growth * tier.height / visual.tier.height), Math.max(.001, growth * tier.bottomRadius / visual.tier.bottomRadius));
    }
    crownGroup.position.y = sample.tower.height;
    const ornaments = new Map(sample.growth.ornaments.map(item => [item.id, item]));
    for (const [id, visual] of ornamentVisuals) {
      const item = ornaments.get(id); visual.group.visible = !!item && (item.scale ?? 1) > .001;
      if (item) {
        visual.group.position.set(item.position.x, item.position.y, item.position.z); visual.group.scale.setScalar(Math.max(.001, item.scale ?? 1));
        const pulse = item.pulse || 0; visual.halo.visible = pulse > .01; visual.halo.material.opacity = pulse * .8; visual.halo.scale.setScalar(1 + pulse * .4); visual.jewel.scale.setScalar(1 + pulse * .12);
      }
    }
    const branches = new Map(sample.growth.branches.map(item => [item.id, item]));
    for (const [id, visual] of branchVisuals) {
      const item = branches.get(id); visual.group.visible = !!item && (item.scale ?? 1) > .001;
      if (!item) continue;
      const start = new THREE.Vector3(item.position.x, item.position.y, item.position.z), tip = new THREE.Vector3(item.tip.x, item.tip.y, item.tip.z);
      const growth = Math.max(.001, item.scale ?? 1); tip.lerpVectors(start, tip, growth);
      const direction = tip.clone().sub(start), length = direction.length();
      visual.stem.position.copy(start.clone().add(tip).multiplyScalar(.5)); visual.stem.scale.y = length;
      visual.stem.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()); visual.gem.position.copy(tip);
      visual.gem.scale.setScalar(growth);
    }
    worldGroup.updateMatrixWorld(true);
  }
  function rebuildWorld({ animate = true } = {}) {
    const previous = displayedWorld || world, wasAnimating = !!transition;
    const before = frameIndex > 0 ? model.frames[frameIndex - 1] : null;
    comparison = compareRevisionTrees(before, model.frames[frameIndex]);
    world = createGrowthWorld(comparisonMode === 'before' && before ? before : model.frames[frameIndex]);
    const shouldAnimate = animate && !reducedMotion && previous && (previous.revision !== world.revision || wasAnimating);
    const plan = buildLibraryTransition(previous, world);
    transition = shouldAnimate ? plan : null; transitionStarted = performance.now();
    transitionFrom = previous ? revisionLabel(model.frames.find(frame => frame.revision === previous.revision)) : '';
    transitionTo = revisionLabel(model.frames.find(frame => frame.revision === world.revision));
    transitionLabel.textContent = `${transitionFrom} → ${transitionTo}`; transitionLabel.hidden = !transition;
    const sample = transition ? sampleLibraryTransition(plan, 0) : world;
    if (selectedId !== null && !world.library.nodes.has(selectedId)) selectedId = null;
    if (!world.library.nodes.has(focusedId)) focusedId = '';
    disposeGroup(worldGroup); pickables = [];
    const ivory = material('#fffdf6'), trim = material('#cfc1a1', { metalness: .52, roughness: .42 });
    platformGroup = new THREE.Group(); worldGroup.add(platformGroup);
    addMesh(platformGroup, new THREE.CylinderGeometry(world.radius + 22, world.radius + 27, 10, 160), material('#f1eee5'), { y: -5 }, '', false);
    addMesh(platformGroup, new THREE.CylinderGeometry(world.radius + 21, world.radius + 21, 1.2, 160), ivory, { y: .7 }, '', false);
    const rim = addMesh(platformGroup, new THREE.TorusGeometry(world.radius + 19, 1.1, 5, 160), trim, { y: 1.7 }, '', false); rim.rotation.x = Math.PI / 2;
    buildShelves(ivory, sample); buildBooks(ivory, sample); buildTower(ivory, trim, sample); buildAnnotations(sample); applyWorldSample(sample);
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
    const sample = transition ? sampleLibraryTransition(transition, clamp((performance.now() - transitionStarted) / growthDuration, 0, 1)) : world;
    pickables = pickables.filter(mesh => !mesh.userData.annotation);
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
    paintRecordLabels(occupied, visible);
    for (const [id, label] of labels) if (!visible.has(id)) label.style.display = 'none';
  }
  function paintRecordLabels(occupied, visible) {
    const shown = displayedWorld || world, available = shown.growth.ornaments.filter(item => item.selectable !== false && (item.scale ?? 1) > .3);
    const nearest = [...available].sort((first, second) => {
      const distance = item => camera.position.distanceToSquared(new THREE.Vector3(item.position.x, item.position.y, item.position.z));
      return distance(first) - distance(second);
    });
    const candidates = ['issue', 'sdd', 'adr'].map(kind => nearest.find(item => item.kind === kind)).filter(Boolean);
    if (hoveredAnnotation) {
      const hovered = hoveredAnnotation.kind === 'branch' ? shown.growth.branches.find(item => item.id === hoveredAnnotation.id) : available.find(item => item.id === hoveredAnnotation.id);
      if (hovered) candidates.unshift(hovered);
    }
    for (const item of candidates) {
      const branch = !!item.sourcePath, key = `record:${item.id}`, point = projectPosition(branch ? item.tip : item.position);
      if (!point || visible.has(key)) continue;
      const name = branch ? 'ADR' : item.kind.toUpperCase(), badge = !branch && item.count > 1 ? String(item.count) : '';
      const box = { left: point.x - 26, right: point.x + 26, top: point.y - 36, bottom: point.y - 8 };
      if (box.left < viewport.left || box.right > viewport.right || box.top < viewport.top || box.bottom > viewport.bottom || occupied.some(other => overlaps(box, other))) continue;
      occupied.push(box); visible.add(key);
      let label = labels.get(key);
      if (!label) {
        label = document.createElement('button'); label.type = 'button'; label.className = 'library-orbit-label library-orbit-record-label';
        label.dataset.annotationId = item.id; label.dataset.annotationKind = branch ? 'branch' : 'ornament';
        const title = document.createElement('span'), count = document.createElement('small'); label.append(title, count);
        label.addEventListener('click', event => { event.stopPropagation(); if (event.detail === 0) activateAnnotation({ id: label.dataset.annotationId, kind: label.dataset.annotationKind }); });
        labelHost.append(label); labels.set(key, label);
      }
      label.firstChild.textContent = name; label.lastChild.textContent = badge; label.lastChild.hidden = !badge;
      label.setAttribute('aria-label', branch ? `ADR ${item.sourcePath}` : `${item.label}、${item.count}件`);
      Object.assign(label.style, { display: 'flex', left: `${box.left}px`, top: `${box.top}px`, width: '52px' });
    }
  }
  function reportState() {
    const constraints = libraryOrbitConstraints(world, { aspect: viewportAspect() });
    const state = { renderer: 'webgl', regionId: focusedId, zoom: constraints.fitDistance / orbit.distance, frameIndex,
      comparisonMode, comparisonStatus: comparison.status, displayRevision: world.library.revision, paletteId,
      growth: world.growth.coverage, ornaments: world.growth.ornaments.length, branches: world.growth.branches.length,
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
        applyWorldSample(sampleLibraryTransition(transition, progress));
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
      const collection = annotation.kind === 'branch' ? displayedWorld.growth.branches : displayedWorld.growth.ornaments;
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
