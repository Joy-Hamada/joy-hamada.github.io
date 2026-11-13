import { createNode, validateFile, polygonArea, polygonBounds, polygonCenter, shrinkPolygon } from './model.mjs';

export const ancestralLayoutVersion = 'ancestral-growth-patches-2';
export const ancestralColorVersion = 'first-parent-activity-medium-lightness-1';
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const districtHues = { apps: 264, lib: 164, tests: 36, docs: 208, scripts: 351, assets: 310, infra: 87 };
const fileArea = 720;
const maximumOutputNodes = 2000000;
const coordinateScale = 1000000;
const partitionNormals = [
  { x: 1, y: 0 }, { x: .8660254037844386, y: .5 }, { x: .5, y: .8660254037844386 },
  { x: 0, y: 1 }, { x: -.5, y: .8660254037844386 }, { x: -.8660254037844386, y: .5 },
];

const orderPaths = (first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0;
const fail = reason => { throw new Error(`project-map-ancestry-${reason}`); };
const quantize = value => Math.round(value * coordinateScale) / coordinateScale || 0;
const quantizeFields = fields => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, quantize(value)]));
const quantizePolygon = polygon => polygon.map(quantizeFields);
const rectangle = ({ x, y, width, height }) => quantizePolygon([
  { x, y }, { x: x + width, y }, { x: x + width, y: y + height }, { x, y: y + height },
]);

function clipPartition(polygon, normal, offset, keepLower) {
  const clipped = []; let previous = polygon.at(-1);
  let previousDistance = normal.x * previous.x + normal.y * previous.y - offset;
  let previousInside = keepLower ? previousDistance <= 0 : previousDistance >= 0;
  for (const current of polygon) {
    const distance = normal.x * current.x + normal.y * current.y - offset;
    const inside = keepLower ? distance <= 0 : distance >= 0;
    if (inside !== previousInside) {
      const fraction = previousDistance / (previousDistance - distance);
      clipped.push({ x: previous.x + (current.x - previous.x) * fraction, y: previous.y + (current.y - previous.y) * fraction });
    }
    if (inside) clipped.push({ ...current });
    previous = current; previousDistance = distance; previousInside = inside;
  }
  return clipped;
}

function partitionCompactness(polygon) {
  let perimeter = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]; const second = polygon[(index + 1) % polygon.length];
    perimeter += quantize(Math.sqrt((first.x - second.x) ** 2 + (first.y - second.y) ** 2));
  }
  return perimeter ** 2 / polygonArea(polygon);
}

function divideStableSiblings(children, polygon, allocations) {
  if (children.length === 1) { allocations.set(children[0].id, polygon); return; }
  const total = children.reduce((sum, child) => sum + child.fileCount, 0);
  let prefix = 0; let split = 1; let leftWeight = children[0].fileCount; let closest = Infinity;
  for (let index = 1; index < children.length; index += 1) {
    prefix += children[index - 1].fileCount;
    const imbalance = Math.abs(total / 2 - prefix);
    if (imbalance < closest) { closest = imbalance; split = index; leftWeight = prefix; }
  }
  const fraction = leftWeight / total; const target = polygonArea(polygon) * fraction;
  let preferred = null; let lowestScore = Infinity;
  // Runtime trigonometry can give the same Git revision a different digest on another browser.
  for (const normal of partitionNormals) {
    const projections = polygon.map(point => point.x * normal.x + point.y * normal.y);
    let lower = Math.min(...projections); let upper = Math.max(...projections);
    for (let iteration = 0; iteration < 42; iteration += 1) {
      const offset = (lower + upper) / 2;
      if (polygonArea(clipPartition(polygon, normal, offset, true)) < target) lower = offset;
      else upper = offset;
    }
    const offset = (lower + upper) / 2;
    const halves = [clipPartition(polygon, normal, offset, true), clipPartition(polygon, normal, offset, false)];
    const first = partitionCompactness(halves[0]); const second = partitionCompactness(halves[1]);
    const score = quantize(Math.max(first, second) + first * fraction + second * (1 - fraction));
    if (score < lowestScore) { preferred = halves; lowestScore = score; }
  }
  if (!preferred) fail('growth-unavailable');
  divideStableSiblings(children.slice(0, split), preferred[0], allocations);
  divideStableSiblings(children.slice(split), preferred[1], allocations);
}

function combinedBounds(regions) {
  if (!regions.length) return { x: 500, y: 390, width: 0, height: 0 };
  const left = Math.min(...regions.map(region => region.x));
  const top = Math.min(...regions.map(region => region.y));
  const right = Math.max(...regions.map(region => region.x + region.width));
  const bottom = Math.max(...regions.map(region => region.y + region.height));
  return quantizeFields({ x: left, y: top, width: right - left, height: bottom - top });
}

function overlaps(first, second) {
  return Math.min(first.x + first.width, second.x + second.width) - Math.max(first.x, second.x) > 1e-7
    && Math.min(first.y + first.height, second.y + second.height) - Math.max(first.y, second.y) > 1e-7;
}

function locateGrowthPatch(patches, count, anchor) {
  const area = count * fileArea;
  const width = quantize(Math.sqrt(area * 1.25)); const height = quantize(area / width);
  if (!patches.length) return quantizeFields({ x: 500 - width / 2, y: 390 - height / 2, width, height });
  const occupied = patches.map(patch => patch.bounds); const extent = combinedBounds(occupied);
  let selected = null; let bestScore = Infinity;
  for (const size of [{ width, height }, { width: height, height: width }]) for (const edge of occupied) {
    const candidates = [
      { x: edge.x + edge.width, y: edge.y }, { x: edge.x + edge.width, y: edge.y + edge.height - size.height },
      { x: edge.x - size.width, y: edge.y }, { x: edge.x - size.width, y: edge.y + edge.height - size.height },
      { x: edge.x, y: edge.y + edge.height }, { x: edge.x + edge.width - size.width, y: edge.y + edge.height },
      { x: edge.x, y: edge.y - size.height }, { x: edge.x + edge.width - size.width, y: edge.y - size.height },
    ];
    for (const position of candidates) {
      const candidate = quantizeFields({ ...position, ...size });
      if (occupied.some(other => overlaps(candidate, other))) continue;
      const bounds = combinedBounds([extent, candidate]);
      const distanceSquared = (candidate.x + size.width / 2 - anchor.x) ** 2 + (candidate.y + size.height / 2 - anchor.y) ** 2;
      const score = quantize(bounds.width * bounds.height + (bounds.width ** 2 + bounds.height ** 2) * .7 + distanceSquared * .18);
      if (score < bestScore - 1e-7) { selected = candidate; bestScore = score; }
    }
  }
  if (!selected || Math.max(Math.abs(selected.x), Math.abs(selected.y), selected.width, selected.height) > 1e7) fail('growth-unavailable');
  return selected;
}

function buildBatchTree(files) {
  const root = createNode('', 'folder'); const nodes = new Map([['', root]]);
  for (const file of files) {
    const segments = file.path.split('/');
    for (let length = 1; length <= segments.length; length += 1) {
      const path = segments.slice(0, length).join('/'); const type = length === segments.length ? 'file' : 'folder';
      if (nodes.has(path) && nodes.get(path).type !== type) fail('path-kind-conflict');
      if (!nodes.has(path)) nodes.set(path, createNode(path, type, type === 'file' ? file : null));
    }
  }
  for (const node of nodes.values()) if (node.parentId !== null) nodes.get(node.parentId).children.push(node.id);
  for (const node of nodes.values()) node.children.sort();
  const ordered = []; const pending = [root];
  while (pending.length) {
    const node = pending.pop(); ordered.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(nodes.get(node.children[index]));
  }
  for (let index = ordered.length - 1; index > 0; index -= 1) nodes.get(ordered[index].parentId).fileCount += ordered[index].fileCount;
  return { nodes, ordered };
}

function nearestExistingParent(file, nodes) {
  const segments = file.path.split('/'); segments.pop();
  while (segments.length) {
    const parent = nodes.get(segments.join('/'));
    if (parent?.polygon.length) return parent.center;
    segments.pop();
  }
  return nodes.get('').center;
}

function addBirthPatch({ files, nodes, patches, revision, ordinal }) {
  const anchors = files.map(file => nearestExistingParent(file, nodes));
  const anchor = { x: anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length,
    y: anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length };
  const bounds = locateGrowthPatch(patches, files.length, anchor);
  const patch = { id: `birth:${revision}`, revision, polygon: rectangle(bounds), bounds, center: quantizeFields(polygonCenter(rectangle(bounds))), nodeIds: [] };
  const batch = buildBatchTree(files); batch.nodes.get('').polygon = patch.polygon;
  for (const local of batch.ordered) {
    let node = nodes.get(local.id);
    if (node && node.type !== local.type) fail('path-kind-conflict');
    if (!node) {
      node = { ...createNode(local.path, local.type, local.file), firstObserved: ordinal, birthRevision: revision,
        birthFileCount: local.fileCount, allocationRound: 0, regions: [], polygons: [] };
      nodes.set(node.id, node); nodes.get(node.parentId).children.push(node.id);
    }
    node.regions.push({ patchId: patch.id, polygon: local.polygon });
    node.polygons.push(local.polygon); patch.nodeIds.push(node.id);
    if (node.polygons.length === 1) {
      node.polygon = local.polygon; node.center = quantizeFields(polygonCenter(local.polygon));
      node.birthFileCount = local.fileCount;
    }
    node.allocationRound = node.polygons.length - 1;
    node.bounds = combinedBounds(node.polygons.map(polygonBounds));
    if (local.children.length) {
      const children = local.children.map(id => batch.nodes.get(id)); const allocations = new Map();
      divideStableSiblings(children, local.polygon, allocations);
      for (const child of children) {
        child.polygon = quantizePolygon(shrinkPolygon(allocations.get(child.id), children.length === 1 ? .997 : .965));
        if (!(polygonArea(child.polygon) > 1e-8)) fail('growth-unavailable');
      }
    }
  }
  patches.push(patch);
}

function pathHash(path) {
  let value = 2166136261;
  for (const character of path) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

export function ancestralColor(path, meanChanges = 0) {
  const segments = path.split('/'); let hue = path ? districtHues[segments[0]] ?? pathHash(segments[0]) % 360 : 43;
  for (let index = 1; index < segments.length; index += 1) hue += ((pathHash(segments.slice(0, index + 1).join('/')) % 17) - 8) / 2 ** (index - 1);
  const intensity = Math.log1p(Math.min(8, Math.max(0, meanChanges))) / Math.log1p(8);
  hue = quantize(hue);
  const saturation = quantize(.14 + intensity * .68); const lightness = .58;
  return { h: hue, s: saturation, l: lightness, css: `hsl(${hue} ${quantize(saturation * 100)}% ${quantize(lightness * 100)}%)` };
}

const units = {
  area: '面積は初出ファイル数に応じた土地です。既存の住所を動かさず、新しい土地を外側へ接続します。',
  height: '縦は選んだPRの順序です。厚みは処理時間・品質を表しません。',
  color: '色相は所属、明度は中程度で固定。彩度は実際の第一親commit間の内容変更回数（初出を除く）、フォルダは観測済みファイルの平均です。',
};

function captureLayout(nodes, patches, revision, originRevision, changes) {
  const copied = structuredClone(nodes); const orderedNodes = []; const pending = [copied.get('')];
  while (pending.length) {
    const node = pending.pop(); node.children.sort(); orderedNodes.push(node);
    node.fileCount = node.type === 'file' ? 1 : 0; node.modificationCount = changes.get(node.id) ?? 0;
    node.maxChanges = node.modificationCount; node.mostChangedPath = node.type === 'file' && node.modificationCount ? node.path : null;
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(copied.get(node.children[index]));
  }
  for (let index = orderedNodes.length - 1; index > 0; index -= 1) {
    const child = orderedNodes[index]; const parent = copied.get(child.parentId);
    parent.fileCount += child.fileCount; parent.modificationCount += child.modificationCount;
    if (child.maxChanges > parent.maxChanges || child.maxChanges === parent.maxChanges && child.mostChangedPath
      && (!parent.mostChangedPath || child.mostChangedPath < parent.mostChangedPath)) {
      parent.maxChanges = child.maxChanges; parent.mostChangedPath = child.mostChangedPath;
    }
  }
  const colors = new Map(orderedNodes.map(node => [node.id, ancestralColor(node.path, node.modificationCount / Math.max(1, node.fileCount))]));
  const activities = new Map(orderedNodes.map(node => [node.id, { status: 'measured', changeEvents: node.modificationCount,
    observedFiles: node.fileCount, meanChanges: node.modificationCount / Math.max(1, node.fileCount), maxChanges: node.maxChanges,
    mostChangedPath: node.mostChangedPath, scaleMax: 8, unit: 'modified-first-parent-commits-per-observed-file' }]));
  const root = copied.get('');
  return { map: { root, nodes: copied, orderedNodes, bounds: { ...root.bounds }, patches: structuredClone(patches), revision,
    layoutVersion: ancestralLayoutVersion, colorVersion: ancestralColorVersion,
    layoutAnchor: { revision: originRevision, layoutVersion: ancestralLayoutVersion },
    units: { weight: 'file-count-at-birth', areaBasis: units.area, gapBasis: '土地のない場所は未割当です。将来のファイル用の予約地ではありません。' } },
  colors, activities, units: { ...units } };
}

export function buildAncestralLayouts({ commits }) {
  if (!Array.isArray(commits) || !commits.length || commits.length > 10000) fail('invalid-chain');
  const root = { ...createNode('', 'folder'), firstObserved: 0, birthRevision: commits[0]?.revision, birthFileCount: 0,
    allocationRound: 0, regions: [], polygons: [], center: { x: 500, y: 390 } };
  const nodes = new Map([['', root]]); const patches = []; const layouts = new Map(); const changes = new Map();
  let previousFiles = new Map(); let outputNodes = 0;
  for (const [ordinal, commit] of commits.entries()) {
    if (!revisionPattern.test(commit?.revision) || layouts.has(commit.revision)
      || commit.parentRevision !== (ordinal ? commits[ordinal - 1].revision : null)
      || !Array.isArray(commit.files) || commit.files.length > 100000) fail('invalid-chain');
    const files = [...commit.files].sort(orderPaths); const current = new Map();
    for (const file of files) {
      validateFile(file);
      if (current.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !revisionPattern.test(file.objectId)) fail('invalid-inventory');
      current.set(file.path, file);
      const existing = nodes.get(file.path);
      if (existing && existing.type !== 'file') fail('path-kind-conflict');
      const previous = previousFiles.get(file.path);
      if (previous && (previous.objectId !== file.objectId || previous.bytes !== file.bytes)) changes.set(file.path, (changes.get(file.path) ?? 0) + 1);
    }
    const newborn = files.filter(file => !nodes.has(file.path));
    if (newborn.length) addBirthPatch({ files: newborn, nodes, patches, revision: commit.revision, ordinal });
    // A deleted path keeps its address; recycling its space would change the meaning of an old landmark.
    for (const node of nodes.values()) if (node.type === 'file') {
      node.present = current.has(node.path);
      if (node.present) node.file = { ...current.get(node.path) };
    }
    outputNodes += nodes.size;
    if (nodes.size > 200000 || outputNodes > maximumOutputNodes) fail('size-limit');
    layouts.set(commit.revision, captureLayout(nodes, patches, commit.revision, commits[0].revision, changes));
    previousFiles = current;
  }
  return layouts;
}
