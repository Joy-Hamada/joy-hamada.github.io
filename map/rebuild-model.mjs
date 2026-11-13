const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maximumFiles = 100000;
const maximumNodes = 200000;
const maximumDepth = 64;
const knownCategories = ['apps', 'lib', 'docs', 'tests', 'scripts', 'assets', 'infra', '.github', '.agents', '.claude', 'snapshots', 'licenses'];
const categorySlots = new Map(knownCategories.map((name, index) => [name, index]));
const themes = { apps: 'castle', docs: 'garden', lib: 'workshop', tests: 'court', snapshots: 'archive' };
const kinds = new Set(['code', 'test', 'document', 'asset', 'config', 'other']);
const orderPaths = (first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0;
const fail = reason => { throw new Error(`revision-town-${reason}`); };

function addBytes(first, second) {
  const sum = first + second;
  if (!Number.isSafeInteger(sum) || sum < 0) fail('invalid-byte-total');
  return sum;
}

function modeOf(file) {
  if (file?.mode === undefined || file.mode === null) return null;
  if (!['100644', '100755'].includes(file.mode)) fail('invalid-mode');
  return file.mode;
}

function inventoryOf(frame) {
  if (!revisionPattern.test(frame?.revision) || !Array.isArray(frame.files) || frame.files.length > maximumFiles
    || frame.files.some(file => !file || typeof file.path !== 'string')) fail('invalid-inventory');
  const files = new Map(); let bytes = 0;
  for (const file of [...frame.files].sort(orderPaths)) {
    if (typeof file?.path !== 'string' || !file.path || file.path.length > 2000 || /[\\\x00-\x1f\x7f:]/.test(file.path)
      || file.path.split('/').some(segment => !segment || segment === '.' || segment === '..') || file.path.split('/').length > maximumDepth
      || file.id !== undefined && file.id !== file.path || !revisionPattern.test(file.objectId)
      || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || files.has(file.path)) fail('invalid-inventory');
    modeOf(file); bytes = addBytes(bytes, file.bytes); files.set(file.path, { ...file });
  }
  for (const path of files.keys()) {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) if (files.has(segments.slice(0, depth).join('/'))) fail('path-kind-conflict');
  }
  return { files, bytes };
}

function boundsFor(x, y, width, height) {
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) fail('invalid-geometry');
  return { minX: x, minY: y, maxX: x + width, maxY: y + height, width, height };
}

function assignRectangle(node, bounds) {
  node.x = bounds.minX; node.y = bounds.minY; node.width = bounds.width; node.height = bounds.height;
  node.bounds = { ...bounds }; node.center = { x: node.x + node.width / 2, y: node.y + node.height / 2 };
  node.polygon = [{ x: node.x, y: node.y }, { x: bounds.maxX, y: node.y }, { x: bounds.maxX, y: bounds.maxY }, { x: node.x, y: bounds.maxY }];
}

function createNode(path, type, file = null) {
  const segments = path ? path.split('/') : [];
  const category = segments.length > 1 || type === 'folder' && path ? segments[0] : file?.kind && kinds.has(file.kind) ? file.kind : 'other';
  return { id: path, path, name: segments.at(-1) ?? 'XOZU', type,
    parentId: path ? segments.slice(0, -1).join('/') : null, children: [],
    fileCount: type === 'file' ? 1 : 0, bytes: file?.bytes ?? 0,
    category: path ? category : 'root', theme: Object.hasOwn(themes, category) ? themes[category] : 'pavilion',
    ...(file ? { objectId: file.objectId, mode: modeOf(file) } : {}) };
}

function inset(bounds, fraction) {
  const horizontal = bounds.width * fraction; const vertical = bounds.height * fraction;
  return boundsFor(bounds.minX + horizontal, bounds.minY + vertical, bounds.width - horizontal * 2, bounds.height - vertical * 2);
}

function divideChildren(children, bounds, allocations) {
  if (!children.length) return;
  if (children.length === 1) { allocations.set(children[0].id, inset(bounds, .0125)); return; }
  const total = children.reduce((sum, child) => sum + child.fileCount, 0);
  let prefix = 0; let split = 1; let leftWeight = children[0].fileCount; let best = Infinity;
  for (let index = 1; index < children.length; index += 1) {
    prefix += children[index - 1].fileCount;
    const difference = Math.abs(total / 2 - prefix);
    if (difference < best) { best = difference; split = index; leftWeight = prefix; }
  }
  const ratio = leftWeight / total; let first; let second;
  if (bounds.width >= bounds.height) {
    const width = bounds.width * ratio;
    first = boundsFor(bounds.minX, bounds.minY, width, bounds.height);
    second = boundsFor(bounds.minX + width, bounds.minY, bounds.width - width, bounds.height);
  } else {
    const height = bounds.height * ratio;
    first = boundsFor(bounds.minX, bounds.minY, bounds.width, height);
    second = boundsFor(bounds.minX, bounds.minY + height, bounds.width, bounds.height - height);
  }
  divideChildren(children.slice(0, split), first, allocations);
  divideChildren(children.slice(split), second, allocations);
}

function positionDescendants(parent, nodes) {
  const allocations = new Map();
  divideChildren(parent.children.map(id => nodes.get(id)), inset(parent.bounds, .035), allocations);
  for (const id of parent.children) assignRectangle(nodes.get(id), allocations.get(id));
}

export function buildRevisionTown(frame) {
  const inventory = inventoryOf(frame);
  const root = createNode('', 'folder'); const nodes = new Map([['', root]]);
  for (const file of inventory.files.values()) {
    const segments = file.path.split('/');
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth).join('/'); const type = depth === segments.length ? 'file' : 'folder';
      if (!nodes.has(path)) nodes.set(path, createNode(path, type, type === 'file' ? file : null));
    }
    if (nodes.size > maximumNodes) fail('node-limit');
  }
  for (const node of nodes.values()) if (node.parentId !== null) nodes.get(node.parentId).children.push(node.id);
  for (const node of nodes.values()) node.children.sort();
  const orderedNodes = []; const pending = [root];
  while (pending.length) {
    const node = pending.pop(); orderedNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(nodes.get(node.children[index]));
  }
  for (let index = orderedNodes.length - 1; index > 0; index -= 1) {
    const node = orderedNodes[index]; const parent = nodes.get(node.parentId);
    parent.fileCount += node.fileCount; parent.bytes = addBytes(parent.bytes, node.bytes);
  }
  const landmarks = root.children.map(id => nodes.get(id)).filter(node => node.type === 'folder');
  const unknownNames = landmarks.filter(node => !categorySlots.has(node.id)).map(node => node.id).sort();
  const unknownSlots = new Map(unknownNames.map((name, index) => [name, knownCategories.length + index]));
  for (const node of landmarks) {
    const slot = categorySlots.get(node.id) ?? unknownSlots.get(node.id);
    const ring = Math.floor(slot / 12) + 1; const angle = -Math.PI / 2 + (slot % 12) * Math.PI / 6;
    const horizontal = Math.cos(angle); const vertical = Math.sin(angle);
    const center = { x: Math.abs(horizontal) < 1e-12 ? 0 : horizontal * 660 * ring, y: Math.abs(vertical) < 1e-12 ? 0 : vertical * 520 * ring };
    const scale = Math.min(1, Math.log2(Math.max(1, node.fileCount)) / 9);
    const width = 120 + scale * 120; const height = 90 + scale * 90;
    assignRectangle(node, boundsFor(center.x - width / 2, center.y - height / 2, width, height));
    node.center = center;
  }
  const directFiles = root.children.map(id => nodes.get(id)).filter(node => node.type === 'file');
  const hubScale = Math.min(1, Math.log2(directFiles.length + 1) / 6);
  const hubWidth = 210 + hubScale * 90; const hubHeight = 160 + hubScale * 60;
  root.hubBounds = boundsFor(-hubWidth / 2, -hubHeight / 2, hubWidth, hubHeight);
  const hubAllocations = new Map(); divideChildren(directFiles, inset(root.hubBounds, .04), hubAllocations);
  for (const file of directFiles) assignRectangle(file, hubAllocations.get(file.id));
  for (const node of orderedNodes) if (node.id && node.type === 'folder') positionDescendants(node, nodes);
  const extents = [root.hubBounds, ...landmarks.map(node => node.bounds)];
  const left = extents.reduce((value, bounds) => Math.min(value, bounds.minX), Infinity);
  const top = extents.reduce((value, bounds) => Math.min(value, bounds.minY), Infinity);
  const right = extents.reduce((value, bounds) => Math.max(value, bounds.maxX), -Infinity);
  const bottom = extents.reduce((value, bounds) => Math.max(value, bounds.maxY), -Infinity);
  assignRectangle(root, boundsFor(left, top, right - left, bottom - top));
  return { policy: 'revision-town-v1', revision: frame.revision, id: `revision-town-v1:${frame.revision}`, root, nodes, orderedNodes, landmarks };
}

function ancestorFolders(path) {
  const segments = path.split('/'); const result = [''];
  for (let depth = 1; depth < segments.length; depth += 1) result.push(segments.slice(0, depth).join('/'));
  return result;
}

function emptyGroup(path, measured) {
  return { path, status: measured ? 'measured' : 'unknown', added: measured ? 0 : null, modified: measured ? 0 : null, deleted: measured ? 0 : null,
    beforeFiles: measured ? 0 : null, afterFiles: 0, beforeBytes: measured ? 0 : null, afterBytes: 0, byteDelta: measured ? 0 : null, changes: [] };
}

export function compareRevisionTrees(beforeFrame, afterFrame) {
  const before = beforeFrame === null ? null : inventoryOf(beforeFrame); const after = inventoryOf(afterFrame);
  const measured = Boolean(before); const groups = new Map([['', emptyGroup('', measured)]]);
  for (const [side, inventory] of [['before', before], ['after', after]]) if (inventory) for (const file of inventory.files.values()) {
    for (const path of ancestorFolders(file.path)) {
      if (!groups.has(path)) groups.set(path, emptyGroup(path, measured));
      const group = groups.get(path); group[`${side}Files`] += 1; group[`${side}Bytes`] = addBytes(group[`${side}Bytes`], file.bytes);
    }
  }
  const changes = [];
  if (before) {
    const paths = [...new Set([...before.files.keys(), ...after.files.keys()])].sort();
    for (const path of paths) {
      const previous = before.files.get(path) ?? null; const current = after.files.get(path) ?? null;
      const contentChanged = !previous || !current || previous.objectId !== current.objectId || previous.bytes !== current.bytes;
      const modeChanged = Boolean(previous && current && modeOf(previous) !== null && modeOf(current) !== null && modeOf(previous) !== modeOf(current));
      if (previous && current && !contentChanged && !modeChanged) continue;
      const change = { path, status: !previous ? 'added' : !current ? 'deleted' : 'modified',
        before: previous, after: current, byteDelta: (current?.bytes ?? 0) - (previous?.bytes ?? 0), contentChanged, modeChanged };
      changes.push(change);
      for (const ancestor of ancestorFolders(path)) { const group = groups.get(ancestor); group[change.status] += 1; group.changes.push(change); }
    }
  }
  for (const group of groups.values()) if (measured) group.byteDelta = group.afterBytes - group.beforeBytes;
  const root = groups.get('');
  const totals = Object.fromEntries(['added', 'modified', 'deleted', 'beforeFiles', 'afterFiles', 'beforeBytes', 'afterBytes', 'byteDelta'].map(field => [field, root[field]]));
  const observedFiles = [...(before?.files.values() ?? []), ...after.files.values()];
  const knownModes = observedFiles.filter(file => modeOf(file) !== null).length;
  const modeCoverage = knownModes === 0 ? 'unavailable' : knownModes === observedFiles.length ? 'complete' : 'partial';
  const changedPaths = new Set(changes.map(change => change.path));
  const unexplainedGitChanges = before && afterFrame.changes?.comparisonRevision === beforeFrame.revision && Array.isArray(afterFrame.changes.modified)
    ? [...new Set(afterFrame.changes.modified.filter(path => typeof path === 'string' && before.files.has(path) && after.files.has(path) && !changedPaths.has(path)))].sort() : [];
  const notes = modeCoverage === 'complete' ? [] : ['mode-unavailable'];
  if (unexplainedGitChanges.length) notes.push('unexplained-git-changes');
  return { status: measured ? 'measured' : 'unknown', fromRevision: beforeFrame?.revision ?? null, toRevision: afterFrame.revision,
    changes, totals, groups: new Map([...groups].sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)),
    modeCoverage, notes, unexplainedGitChanges };
}
