const fullTurn = Math.PI * 2;
const siblingScale = .965;
const singleChildScale = .997;
const cutAngles = [0, 1, 2, 3, 4, 5].map(step => step * Math.PI / 6);

function orderPaths(first, second) { return first.path < second.path ? -1 : first.path > second.path ? 1 : 0; }

export function polygonArea(polygon) {
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]; const second = polygon[(index + 1) % polygon.length];
    twiceArea += first.x * second.y - second.x * first.y;
  }
  return Math.abs(twiceArea) / 2;
}

function polygonBounds(polygon) {
  const horizontal = polygon.map(point => point.x); const vertical = polygon.map(point => point.y);
  const x = Math.min(...horizontal); const y = Math.min(...vertical);
  return { x, y, width: Math.max(...horizontal) - x, height: Math.max(...vertical) - y };
}

function polygonCenter(polygon) {
  let twiceArea = 0; let horizontal = 0; let vertical = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]; const second = polygon[(index + 1) % polygon.length];
    const cross = first.x * second.y - second.x * first.y;
    twiceArea += cross;
    horizontal += (first.x + second.x) * cross;
    vertical += (first.y + second.y) * cross;
  }
  return { x: horizontal / (3 * twiceArea), y: vertical / (3 * twiceArea) };
}

export function containsPoint(polygon, point) {
  if (!Array.isArray(polygon) || polygon.length < 3 || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) return false;
  let positive = false; let negative = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]; const second = polygon[(index + 1) % polygon.length];
    const cross = (second.x - first.x) * (point.y - first.y) - (second.y - first.y) * (point.x - first.x);
    const tolerance = Math.hypot(second.x - first.x, second.y - first.y) * 1e-8;
    if (cross > tolerance) positive = true;
    if (cross < -tolerance) negative = true;
    if (positive && negative) return false;
  }
  return true;
}

function clipHalfPlane(polygon, normal, offset, keepLower) {
  const clipped = [];
  let previous = polygon.at(-1);
  let previousDistance = normal.x * previous.x + normal.y * previous.y - offset;
  let previousInside = keepLower ? previousDistance <= 0 : previousDistance >= 0;
  for (const current of polygon) {
    const currentDistance = normal.x * current.x + normal.y * current.y - offset;
    const currentInside = keepLower ? currentDistance <= 0 : currentDistance >= 0;
    if (currentInside !== previousInside) {
      const fraction = previousDistance / (previousDistance - currentDistance);
      clipped.push({ x: previous.x + (current.x - previous.x) * fraction, y: previous.y + (current.y - previous.y) * fraction });
    }
    if (currentInside) clipped.push({ ...current });
    previous = current; previousDistance = currentDistance; previousInside = currentInside;
  }
  return clipped;
}

function cutByArea(polygon, fraction, angle) {
  const normal = { x: Math.cos(angle), y: Math.sin(angle) };
  const projections = polygon.map(point => point.x * normal.x + point.y * normal.y);
  let lower = Math.min(...projections); let upper = Math.max(...projections);
  const targetArea = polygonArea(polygon) * fraction;
  for (let iteration = 0; iteration < 42; iteration += 1) {
    const offset = (lower + upper) / 2;
    if (polygonArea(clipHalfPlane(polygon, normal, offset, true)) < targetArea) lower = offset;
    else upper = offset;
  }
  const offset = (lower + upper) / 2;
  return [clipHalfPlane(polygon, normal, offset, true), clipHalfPlane(polygon, normal, offset, false)];
}

function compactness(polygon) {
  const area = polygonArea(polygon);
  let perimeter = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]; const second = polygon[(index + 1) % polygon.length];
    perimeter += Math.hypot(first.x - second.x, first.y - second.y);
  }
  return perimeter * perimeter / (2 * fullTurn * area);
}

function choosePartition(polygon, fraction) {
  let preferred = null; let lowestScore = Infinity;
  for (const angle of cutAngles) {
    const halves = cutByArea(polygon, fraction, angle);
    const first = compactness(halves[0]); const second = compactness(halves[1]);
    const score = Math.max(first, second) + first * fraction + second * (1 - fraction);
    if (score < lowestScore - 1e-10) { preferred = halves; lowestScore = score; }
  }
  if (!preferred) throw new Error('project-map-layout-unavailable');
  return preferred;
}

function divideSiblings(children, polygon, allocations) {
  if (children.length === 1) { allocations.set(children[0].id, polygon); return; }
  const total = children.reduce((sum, child) => sum + child.fileCount, 0);
  let prefix = 0; let split = 1; let leftWeight = children[0].fileCount; let closest = Infinity;
  for (let index = 1; index < children.length; index += 1) {
    prefix += children[index - 1].fileCount;
    const imbalance = Math.abs(total / 2 - prefix);
    if (imbalance < closest) { closest = imbalance; split = index; leftWeight = prefix; }
  }
  const [left, right] = choosePartition(polygon, leftWeight / total);
  divideSiblings(children.slice(0, split), left, allocations);
  divideSiblings(children.slice(split), right, allocations);
}

function shrinkPolygon(polygon, scale) {
  const center = polygonCenter(polygon);
  return polygon.map(point => ({ x: center.x + (point.x - center.x) * scale, y: center.y + (point.y - center.y) * scale }));
}

function validateFile(file) {
  if (typeof file?.path !== 'string' || !file.path || file.path.length > 2000 || /[\\\x00-\x1f\x7f:]/.test(file.path) ||
      file.path.split('/').some(segment => !segment || segment === '.' || segment === '..') ||
      (file.id !== undefined && file.id !== file.path)) throw new Error('invalid-project-map-inventory');
}

function createNode(path, type, file = null) {
  const segments = path ? path.split('/') : [];
  return {
    id: path, path, name: segments.at(-1) ?? 'XOZU', type,
    parentId: path ? segments.slice(0, -1).join('/') : null,
    children: [], depth: segments.length, fileCount: type === 'file' ? 1 : 0,
    polygon: [], bounds: { x: 0, y: 0, width: 0, height: 0 }, center: { x: 0, y: 0 },
    ...(file ? { file: { ...file } } : {}),
  };
}

export function buildProjectMap(inventory) {
  if (!Array.isArray(inventory?.files) || inventory.files.length > 100000) throw new Error('invalid-project-map-inventory');
  const root = createNode('', 'folder');
  const nodes = new Map([['', root]]);
  const files = [...inventory.files].sort(orderPaths);
  for (const file of files) {
    validateFile(file);
    if (nodes.has(file.path)) throw new Error('invalid-project-map-inventory');
    const segments = file.path.split('/');
    for (let length = 1; length < segments.length; length += 1) {
      const path = segments.slice(0, length).join('/');
      if (nodes.has(path) && nodes.get(path).type !== 'folder') throw new Error('invalid-project-map-inventory');
      if (!nodes.has(path)) nodes.set(path, createNode(path, 'folder'));
    }
    nodes.set(file.path, createNode(file.path, 'file', file));
  }
  for (const node of nodes.values()) {
    if (node.parentId !== null) nodes.get(node.parentId).children.push(node.id);
  }
  for (const node of nodes.values()) node.children.sort();
  const orderedNodes = [];
  const pending = [root];
  while (pending.length) {
    const node = pending.pop(); orderedNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(nodes.get(node.children[index]));
  }
  for (let index = orderedNodes.length - 1; index > 0; index -= 1) {
    const node = orderedNodes[index]; nodes.get(node.parentId).fileCount += node.fileCount;
  }
  const outline = [
    { x: 130, y: 0 }, { x: 870, y: 0 }, { x: 1000, y: 100 }, { x: 1000, y: 680 },
    { x: 870, y: 780 }, { x: 130, y: 780 }, { x: 0, y: 680 }, { x: 0, y: 100 },
  ];
  root.polygon = root.fileCount ? outline : [];
  root.bounds = { x: 0, y: 0, width: 1000, height: 780 };
  root.center = { x: 500, y: 390 };
  // Recomputing from a focus or camera would move familiar regions; only the fixed inventory enters this layout.
  for (const parent of orderedNodes) {
    if (!parent.children.length) continue;
    const children = parent.children.map(id => nodes.get(id));
    const allocations = new Map();
    divideSiblings(children, parent.polygon, allocations);
    for (const child of children) {
      // A small inset preserves long single-child paths without inventing extra hierarchy levels.
      child.polygon = shrinkPolygon(allocations.get(child.id), children.length === 1 ? singleChildScale : siblingScale);
      child.bounds = polygonBounds(child.polygon); child.center = polygonCenter(child.polygon);
      if (!(polygonArea(child.polygon) > 0) || !Number.isFinite(child.center.x) || !Number.isFinite(child.center.y)) throw new Error('project-map-layout-unavailable');
    }
  }
  return {
    root, nodes, orderedNodes, bounds: { ...root.bounds }, revision: inventory.revision,
    coverage: inventory.coverage ? { ...inventory.coverage } : null,
    layoutVersion: 'nested-convex-partitions-1',
    units: {
      weight: 'included-file-count', fileWeight: 1, siblingScale, singleChildScale,
      areaBasis: '同じ親の中の面積比は配下ファイル数の比です。階層ごとの余白を含むため、別階層の面積を直接比較しません。',
      gapBasis: '余白は所属を見分けるための表示上の補正です。品質・重要度・依存関係を表しません。',
    },
  };
}

export function traceProjectMapAncestors(map, id) {
  const ancestors = [];
  let node = map?.nodes?.get(id);
  while (node) {
    ancestors.push(node);
    node = node.parentId === null ? null : map.nodes.get(node.parentId);
  }
  return ancestors.reverse();
}

export { createNode, validateFile, choosePartition, divideSiblings, polygonBounds, polygonCenter, shrinkPolygon };
