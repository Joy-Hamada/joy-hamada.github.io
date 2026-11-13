import { createNode, validateFile, choosePartition, divideSiblings, polygonArea, polygonBounds, polygonCenter, shrinkPolygon, containsPoint } from './model.mjs';

const layoutVersion = 'birth-allocated-convex-1';
const initialShare = .72;
const minimumArea = 1e-6;
const outline = [
  { x: 130, y: 0 }, { x: 870, y: 0 }, { x: 1000, y: 100 }, { x: 1000, y: 680 },
  { x: 870, y: 780 }, { x: 130, y: 780 }, { x: 0, y: 680 }, { x: 0, y: 100 },
];

function assertUsableRegion(polygon, parent = null) {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))
    || !(polygonArea(polygon) >= minimumArea) || parent && polygon.some(point => !containsPoint(parent, point))) {
    throw new Error('project-map-growth-space-exhausted');
  }
}

function countCurrentFiles(files) {
  const counts = new Map([['', files.length]]);
  for (const file of files) {
    const segments = file.path.split('/');
    for (let length = 1; length <= segments.length; length += 1) {
      const path = segments.slice(0, length).join('/'); counts.set(path, (counts.get(path) ?? 0) + 1);
    }
  }
  return counts;
}

function divideGrowthSpace(polygon, fraction) {
  try { return choosePartition(polygon, fraction); }
  catch { throw new Error('project-map-growth-space-exhausted'); }
}

export function buildBirthProjectMap({ frames, coverage = null, anchorRevision = frames?.[0]?.revision }) {
  if (!Array.isArray(frames) || !frames.length || frames.length > 65 || frames.some(frame => !Array.isArray(frame?.files) || frame.files.length > 100000)) {
    throw new Error('invalid-project-map-inventory');
  }
  if (anchorRevision !== frames[0].revision) throw new Error('project-map-layout-anchor-mismatch');
  const root = createNode('', 'folder'); root.firstObserved = 0;
  const nodes = new Map([['', root]]);
  let fileCount = 0;
  for (const [index, frame] of frames.entries()) {
    const seen = new Set();
    for (const file of frame.files) {
      validateFile(file);
      if (seen.has(file.path)) throw new Error('invalid-project-map-inventory');
      seen.add(file.path);
      const segments = file.path.split('/');
      for (let length = 1; length <= segments.length; length += 1) {
        const path = segments.slice(0, length).join('/');
        const type = length === segments.length ? 'file' : 'folder';
        const existing = nodes.get(path);
        if (existing && existing.type !== type) throw new Error('project-map-path-kind-conflict');
        if (!existing) {
          if (type === 'file' && ++fileCount > 100000) throw new Error('invalid-project-map-inventory');
          const node = createNode(path, type, type === 'file' ? file : null);
          node.firstObserved = index; nodes.set(path, node);
        }
      }
    }
  }
  for (const node of nodes.values()) if (node.parentId !== null) nodes.get(node.parentId).children.push(node.id);
  for (const node of nodes.values()) node.children.sort();
  const orderedNodes = []; const pending = [root];
  while (pending.length) {
    const node = pending.pop(); orderedNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(nodes.get(node.children[index]));
  }
  for (let index = orderedNodes.length - 1; index > 0; index -= 1) {
    const node = orderedNodes[index]; nodes.get(node.parentId).fileCount += node.fileCount;
  }
  root.polygon = outline.map(point => ({ ...point }));
  root.bounds = { x: 0, y: 0, width: 1000, height: 780 }; root.center = { x: 500, y: 390 };
  root.birthFileCount = frames[0].files.length; root.allocationRound = 0;
  const growthSpaces = new Map([['', root.polygon]]); const allocationRounds = new Map();
  for (const [index, frame] of frames.entries()) {
    const currentCounts = countCurrentFiles(frame.files);
    for (const parent of orderedNodes) {
      if (parent.type !== 'folder' || parent.firstObserved > index) continue;
      const newborn = parent.children.map(id => nodes.get(id)).filter(node => node.firstObserved === index);
      if (!newborn.length) continue;
      const remaining = growthSpaces.get(parent.id);
      assertUsableRegion(remaining, parent.polygon);
      const round = allocationRounds.get(parent.id) ?? 0;
      // Later batches consume only unallocated parent space, never the earlier children's addresses.
      const fraction = round === 0 ? initialShare : 1 / (round + 1);
      const [available, reserve] = divideGrowthSpace(remaining, fraction);
      assertUsableRegion(available, parent.polygon); assertUsableRegion(reserve, parent.polygon);
      const allocations = new Map();
      const weighted = newborn.map(node => ({ ...node, fileCount: currentCounts.get(node.path) ?? 0 }));
      if (weighted.some(node => node.fileCount < 1)) throw new Error('invalid-project-map-birth');
      divideSiblings(weighted, available, allocations);
      for (const child of newborn) {
        child.polygon = shrinkPolygon(allocations.get(child.id), newborn.length === 1 ? .997 : .965);
        assertUsableRegion(child.polygon, parent.polygon);
        child.bounds = polygonBounds(child.polygon); child.center = polygonCenter(child.polygon);
        if (!Number.isFinite(child.center.x) || !Number.isFinite(child.center.y) || !containsPoint(child.polygon, child.center)) throw new Error('project-map-growth-space-exhausted');
        child.birthFileCount = currentCounts.get(child.path); child.allocationRound = round;
        if (child.type === 'folder') growthSpaces.set(child.id, child.polygon);
      }
      growthSpaces.set(parent.id, reserve); allocationRounds.set(parent.id, round + 1);
    }
  }
  return {
    root, nodes, orderedNodes, bounds: { ...root.bounds }, revision: frames.at(-1).revision,
    coverage: coverage ? { ...coverage } : null, layoutVersion,
    layoutAnchor: { revision: anchorRevision, layoutVersion },
    units: {
      weight: 'file-count-at-first-appearance-within-new-batch', initialShare,
      areaBasis: '面積は初出時に割り当てた住所です。後から増えたファイルや現在のコード量に比例して並べ直しません。',
      gapBasis: '区画のない部分は親の成長余白です。未来のファイル・欠損・品質を表しません。',
    },
  };
}
