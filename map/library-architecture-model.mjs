import { compareRevisionTrees } from './rebuild-model.mjs';

export const libraryArchitecturePolicy = 'first-parent-library-terraces-v1';
export const libraryArchitectureLimits = Object.freeze({ contourPoints: 64, maximumRadius: 124, baselineHeight: 16, minimumLayerHeight: 4.5, maximumLayerHeight: 11 });
const fullTurn = Math.PI * 2;
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const categories = ['apps', 'lib', 'docs', 'tests', 'scripts', 'assets', 'infra', '.github', '.agents', '.claude', 'snapshots', 'licenses'];
const mapping = Object.freeze({ layer: 'one-actual-first-parent-commit', height: 'bounded-log-changed-file-count',
  footprint: 'root-folder-change-distribution-and-change-fingerprint', indentation: 'deleted-file-share',
  baseline: 'uncompared-root-inventory', quality: 'not-assessed', books: 'current-inventory-separate-from-historical-layers' });
const lexical = (first, second) => first < second ? -1 : first > second ? 1 : 0;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const mix = (first, second, progress) => progress === 0 ? first : progress === 1 ? second : first + (second - first) * progress;

function fingerprint(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function bearingFor(category) {
  const index = categories.indexOf(category);
  if (index >= 0) return -Math.PI / 2 + index * fullTurn / categories.length;
  if (category === '') return Math.PI / 12;
  return fingerprint(category) / 4294967296 * fullTurn;
}

function rootFolder(path) { return path.includes('/') ? path.split('/')[0] : ''; }
function recordedDocument(path) { return /^docs\/(?:issues\/ISS-|decisions\/ADR-|spec-driven-dev\/(?:req\/REQ-|design\/DES-))\d{4}\.md$/.test(path); }

function unknownArchitecture(revision, reason, missingRevision = null) {
  return { policy: libraryArchitecturePolicy, revision, status: 'unknown', baseline: null, layers: [], height: null, radius: null,
    coverage: { status: 'unknown', reason, missingRevision, commitCount: null, comparedCount: null }, mapping };
}

function traceFirstParents(history, revision) {
  if (!revisionPattern.test(revision) || history?.ancestry?.policy !== 'first-parent-root-v1' || !Array.isArray(history.ancestry.commits)) {
    return { reason: 'ancestry-unavailable' };
  }
  if (history.ancestry.commits.length > 1000) return { reason: 'ancestry-limit' };
  const commits = new Map();
  for (const commit of history.ancestry.commits) {
    if (!commit || !revisionPattern.test(commit.revision) || commits.has(commit.revision)) return { reason: 'invalid-or-duplicate-revision' };
    commits.set(commit.revision, commit);
  }
  const reverse = [], visited = new Set(); let current = revision; let inventoryRows = 0;
  while (current !== null) {
    const commit = commits.get(current);
    if (!commit) return { reason: 'ancestor-unavailable', missingRevision: current };
    if (visited.has(current)) return { reason: 'ancestry-cycle' };
    visited.add(current);
    if (!Array.isArray(commit.parents) || commit.parents.some(parent => !revisionPattern.test(parent))
      || new Set(commit.parents).size !== commit.parents.length || (commit.parents[0] ?? null) !== commit.parentRevision
      || !Array.isArray(commit.files) || (inventoryRows += commit.files.length) > 500000) return { reason: 'invalid-ancestry' };
    reverse.push(commit); current = commit.parentRevision;
  }
  const chain = reverse.reverse();
  if (chain[0].revision !== history.ancestry.rootRevision) return { reason: 'root-mismatch' };
  return { chain };
}

function summarizeChanges(comparison, current) {
  const observed = comparison.status === 'measured' ? comparison.changes
    : [...current.files].sort((first, second) => lexical(first.path, second.path)).map(file => ({ path: file.path, status: 'baseline', before: null, after: file }));
  const groups = new Map(), kinds = new Map();
  for (const change of observed) {
    const path = rootFolder(change.path);
    if (!groups.has(path)) groups.set(path, { path, bearing: bearingFor(path), added: 0, modified: 0, deleted: 0, baseline: 0, count: 0 });
    const group = groups.get(path); group[change.status] += 1; group.count += 1;
    const kind = (change.after ?? change.before)?.kind ?? 'other'; kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const orderedGroups = [...groups.values()].sort((first, second) => lexical(first.path, second.path));
  const signature = JSON.stringify(observed.map(change => [change.path, change.status, change.before?.objectId ?? null,
    change.after?.objectId ?? null, change.before?.bytes ?? null, change.after?.bytes ?? null, change.before?.mode ?? null, change.after?.mode ?? null]));
  const dominant = [...orderedGroups].sort((first, second) => second.count - first.count || lexical(first.path, second.path))[0];
  const dominantKind = [...kinds].sort(([firstKind, firstCount], [secondKind, secondCount]) => secondCount - firstCount || lexical(firstKind, secondKind))[0]?.[0] ?? 'other';
  return { groups: orderedGroups, count: observed.length, changeFingerprint: fingerprint(signature).toString(16).padStart(8, '0'),
    category: dominant?.path ?? '', accentKind: dominantKind,
    recordPaths: observed.filter(change => change.after && recordedDocument(change.path)).map(change => change.path) };
}

function createContour(summary, { baseline = false } = {}) {
  const count = Math.max(1, summary.count), hash = Number.parseInt(summary.changeFingerprint, 16);
  const weight = summary.groups.reduce((sum, group) => sum + Math.sqrt(group.count), 0) || 1;
  const center = summary.groups.reduce((point, group) => ({ x: point.x + Math.cos(group.bearing) * Math.sqrt(group.count) / weight * 22,
    z: point.z + Math.sin(group.bearing) * Math.sqrt(group.count) / weight * 22 }), { x: 0, z: 0 });
  const countScale = Math.min(18, Math.log2(count + 1) * 2.6);
  const phase = hash / 4294967296 * fullTurn;
  const harmonic = 2 + hash % 3;
  return Array.from({ length: libraryArchitectureLimits.contourPoints }, (_, index) => {
    const angle = index * fullTurn / libraryArchitectureLimits.contourPoints;
    let radius = (baseline ? 56 : 64) + countScale;
    for (const group of summary.groups) {
      const kernel = Math.exp(3 * (Math.cos(angle - group.bearing) - 1));
      const intensity = Math.sqrt(group.count) / weight;
      const localCount = Math.max(1, group.count);
      radius += intensity * kernel * (50 * (group.added + group.baseline) / localCount + 34 * group.modified / localCount - 42 * group.deleted / localCount);
    }
    radius += Math.sin(angle * harmonic + phase) * (baseline ? 4 : 9);
    radius = clamp(radius, Math.hypot(center.x, center.z) + 24, 112);
    const point = { x: center.x + Math.cos(angle) * radius, z: center.z + Math.sin(angle) * radius };
    const length = Math.hypot(point.x, point.z), scale = Math.min(1, libraryArchitectureLimits.maximumRadius / length);
    return { x: point.x * scale, z: point.z * scale };
  });
}

function frameLabel(frame, revision) { return frame?.pr?.number ? `PR #${frame.pr.number}` : `Git ${revision.slice(0, 7)}`; }

export function buildLibraryArchitecture(history, revision) {
  const ancestry = traceFirstParents(history, revision);
  if (!ancestry.chain) return unknownArchitecture(revision, ancestry.reason, ancestry.missingRevision);
  if (history.frames !== undefined && (!Array.isArray(history.frames) || history.frames.some(frame => !frame || !revisionPattern.test(frame.revision)))) {
    return unknownArchitecture(revision, 'invalid-chapter-metadata');
  }
  const frames = new Map((history.frames ?? []).map(frame => [frame.revision, frame]));
  const layers = []; let baseline = null, previous = null, top = 6, radius = 0;
  try {
    for (const commit of ancestry.chain) {
      const comparison = compareRevisionTrees(previous, commit);
      const frame = frames.get(commit.revision);
      if (frame && compareRevisionTrees(commit, frame).changes.length) return unknownArchitecture(revision, 'chapter-inventory-mismatch', commit.revision);
      const summary = summarizeChanges(comparison, commit), isBaseline = previous === null;
      const height = isBaseline ? libraryArchitectureLimits.baselineHeight
        : libraryArchitectureLimits.minimumLayerHeight + Math.min(libraryArchitectureLimits.maximumLayerHeight - libraryArchitectureLimits.minimumLayerHeight, Math.log2(summary.count + 1));
      const contour = createContour(summary, { baseline: isBaseline });
      const deletedShare = comparison.status === 'measured' ? comparison.totals.deleted / Math.max(1, summary.count) : 0;
      const layer = { id: isBaseline ? `baseline:${commit.revision}` : commit.revision, revision: commit.revision,
        fromRevision: previous?.revision ?? null, prNumber: frame?.pr?.number ?? null, label: frameLabel(frame, commit.revision),
        y: top, height, contour, inset: 5 + deletedShare * 4, comparisonStatus: comparison.status,
        changes: { ...comparison.totals }, ...summary, attribution: frame?.changes?.attribution ?? 'first-parent-commit',
        comparisonNotes: [...comparison.notes] };
      if (isBaseline) baseline = layer; else layers.push(layer);
      top += height; radius = Math.max(radius, ...contour.map(point => Math.hypot(point.x, point.z))); previous = commit;
    }
  } catch {
    return unknownArchitecture(revision, 'invalid-inventory');
  }
  return { policy: libraryArchitecturePolicy, revision, status: 'ready', baseline, layers, height: top, radius,
    coverage: { status: 'complete', reason: null, missingRevision: null, commitCount: ancestry.chain.length, comparedCount: layers.length }, mapping };
}

function architectureItems(architecture) { return architecture?.status === 'ready' ? [...(architecture.baseline ? [architecture.baseline] : []), ...architecture.layers] : []; }

function sampleLayer(before, after, progress, anchorY) {
  const target = after ?? before;
  const contour = target.contour.map((point, index) => ({ x: mix(before?.contour[index].x ?? point.x, after?.contour[index].x ?? point.x, progress),
    z: mix(before?.contour[index].z ?? point.z, after?.contour[index].z ?? point.z, progress) }));
  return { ...target, contour, y: mix(before?.y ?? anchorY, after?.y ?? anchorY, progress),
    height: mix(before?.height ?? 0, after?.height ?? 0, progress), inset: mix(before?.inset ?? target.inset, after?.inset ?? target.inset, progress),
    opacity: mix(finiteOr(before?.opacity, before ? 1 : 0), after ? 1 : 0, progress),
    scale: mix(finiteOr(before?.scale, before ? 1 : 0), after ? 1 : 0, progress),
    selectable: Boolean(after), status: !before ? 'added' : !after ? 'deleted' : 'unchanged' };
}

export function sampleLibraryArchitecture(from, to, progress) {
  if (to?.status !== 'ready') return to ?? unknownArchitecture(null, 'ancestry-unavailable');
  const normalized = clamp(finiteOr(progress, 0), 0, 1), amount = normalized * normalized * (3 - 2 * normalized);
  const before = new Map(architectureItems(from).map(layer => [layer.id, layer]));
  const after = new Map(architectureItems(to).map(layer => [layer.id, layer]));
  const shared = [...before.values()].filter(layer => after.has(layer.id));
  const anchorY = shared.length ? Math.max(...shared.map(layer => layer.y + layer.height)) : 6;
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  const sampled = ids.filter(id => amount < 1 || after.has(id)).map(id => sampleLayer(before.get(id), after.get(id), amount, anchorY))
    .sort((first, second) => first.y - second.y || lexical(first.id, second.id));
  const baseline = sampled.find(layer => layer.id === to.baseline.id) ?? null;
  return { ...to, baseline, layers: sampled.filter(layer => layer !== baseline),
    height: mix(finiteOr(from?.height, 6), to.height, amount), radius: mix(finiteOr(from?.radius, to.radius), to.radius, amount),
    transition: { progress: amount, fromRevision: from?.revision ?? null, toRevision: to.revision } };
}
