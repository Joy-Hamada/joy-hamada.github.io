const changeLabels = { added: '追加', modified: '変更', deleted: '削除' };
const pinKinds = ['change', 'issue', 'sdd', 'adr'];
const compareIds = (left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
const finitePoint = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);
const pinKindLabels = { change: '変更', issue: 'Issue', sdd: 'SDD', adr: 'ADR', mixed: '混合' };

export function describeMapPinCluster(cluster, activePinIds = []) {
  const count = cluster.members.length;
  const kindLabel = pinKindLabels[cluster.kind] ?? pinKindLabels.mixed;
  const selectedIds = new Set(activePinIds);
  const changes = Object.fromEntries(Object.keys(changeLabels).map(change => [change, cluster.members.filter(pin => pin.change === change).length]));
  const missingChanges = count - Object.values(changes).reduce((sum, amount) => sum + amount, 0);
  const changeSummary = Object.entries(changes).filter(([, amount]) => amount).map(([change, amount]) => `${changeLabels[change]} ${amount}件`);
  if (missingChanges) changeSummary.push(`変更種未記録 ${missingChanges}件`);
  const paths = [...new Set(cluster.members.map(pin => pin.path).filter(path => typeof path === 'string' && path))].sort();
  const pathSummary = paths.slice(0, 3).join('、');
  const remainingPaths = paths.length > 3 ? ` ほか ${paths.length - 3}件` : '';
  const detail = cluster.kind === 'change' && changeSummary.length ? `（${changeSummary.join('・')}）` : '';
  const ariaLabel = `${kindLabel} ${count}件${detail}${pathSummary ? ` · ${pathSummary}${remainingPaths}` : ''}`;
  return {
    kindLabel, countLabel: count > 999 ? '999+' : String(count), ariaLabel,
    selected: cluster.members.some(pin => selectedIds.has(pin.id)),
  };
}

function fileMetadata(file) {
  if (!file) return null;
  return Object.fromEntries(['path', 'bytes', 'objectId', 'kind', 'mode'].filter(key => file[key] !== undefined).map(key => [key, file[key]]));
}

function pinAddress(map, path) {
  const node = map?.nodes?.get(path);
  // A nearby parent would imply a relationship we have not established.
  return node?.type === 'file' && finitePoint(node.center) ? { x: node.center.x, y: node.center.y } : null;
}

function describeChange(change, before, after) {
  const bytes = file => Number.isSafeInteger(file?.bytes) ? `${file.bytes} B` : 'サイズ未記録';
  if (change === 'added') return `この版で追加。${bytes(after)}。`;
  if (change === 'deleted') return `前の表示版から削除。削除前は${bytes(before)}。`;
  return `前の表示版から変更。${bytes(before)} → ${bytes(after)}。`;
}

export function buildMapPins(model, index) {
  if (!Number.isInteger(index) || index < 0 || index >= model.frames.length) throw new RangeError('map-pins-frame-index');
  const frame = model.frames[index]; const previous = model.frames[index - 1];
  const map = typeof model.mapFor === 'function' ? model.mapFor(index) : model.map;
  const currentFiles = new Map(frame.files.map(file => [file.path, file]));
  const previousFiles = new Map((previous?.files ?? []).map(file => [file.path, file]));
  const pins = [];
  const createPin = (kind, path) => ({ id: `${frame.revision}:${kind}:${path}`, kind, path, nodeId: path,
    revision: frame.revision, label: path.split('/').at(-1), world: pinAddress(map, path) });

  // The baseline has no observed predecessor; presence alone is not an addition.
  if (previous && frame.changes?.status === 'measured') {
    if (frame.changes.comparisonRevision && frame.changes.comparisonRevision !== previous.revision) throw new Error('map-pins-comparison-revision');
    for (const change of ['added', 'modified', 'deleted']) {
      for (const path of new Set(frame.changes[change] ?? [])) {
        const before = fileMetadata(previousFiles.get(path)); const after = fileMetadata(currentFiles.get(path));
        const observed = change === 'added' ? !before && after : change === 'deleted' ? before && !after : before && after;
        if (!observed) throw new Error('map-pins-change-evidence');
        pins.push({ ...createPin('change', path), label: `${changeLabels[change]} · ${path.split('/').at(-1)}`,
          change, before, after, comparisonRevision: previous.revision, summary: describeChange(change, before, after),
          basis: 'git-diff-between-displayed-versions' });
      }
    }
  }

  return pins.sort(compareIds);
}

function assertClusteringOptions(bounds, radius) {
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError('map-pins-cluster-radius');
  if (bounds && (!['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(bounds[key]))
    || bounds.left > bounds.right || bounds.top > bounds.bottom)) throw new RangeError('map-pins-cluster-bounds');
}

export function clusterMapPins(projectedPins, { bounds, radius = 36 } = {}) {
  assertClusteringOptions(bounds, radius);
  const groups = []; const offscreen = []; const unplaced = [];
  for (const pin of [...projectedPins].sort(compareIds)) {
    if (!finitePoint(pin.screen)) { unplaced.push(pin); continue; }
    const { x, y } = pin.screen;
    if (pin.visible === false || bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) {
      offscreen.push(pin); continue;
    }
    let nearest = null; let nearestDistance = Infinity;
    for (const group of groups) {
      if (group.kind !== pin.kind) continue;
      const distance = Math.hypot(x - group.anchor.x, y - group.anchor.y);
      if (distance <= radius && distance < nearestDistance) { nearest = group; nearestDistance = distance; }
    }
    if (nearest) nearest.members.push(pin);
    else groups.push({ kind: pin.kind, anchor: { x, y }, members: [pin] });
  }
  const clusters = groups.map(({ kind, members }) => ({ id: JSON.stringify(['map-pin-cluster', kind, ...members.map(pin => pin.id)]),
    kind, count: members.length, members,
    screen: { x: members.reduce((sum, pin) => sum + pin.screen.x, 0) / members.length,
      y: members.reduce((sum, pin) => sum + pin.screen.y, 0) / members.length } }));
  clusters.sort((left, right) => pinKinds.indexOf(left.kind) - pinKinds.indexOf(right.kind) || compareIds(left, right));
  return { clusters, offscreen, unplaced, total: projectedPins.length };
}
