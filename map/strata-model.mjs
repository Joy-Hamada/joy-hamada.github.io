import { polygonArea } from './model.mjs';
import { buildBirthProjectMap } from './birth-layout.mjs';
import { buildAncestralStrataModel } from './ancestral-model.mjs';
import { assertVerifiedHistoryMaps, canonicalMapJson, digestMapValue, projectMapSource, restoreProjectMapSnapshot, validateMapSnapshotContinuity, validateProjectMapSnapshot } from './map-snapshot.mjs';

const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const districtHues = { apps: 264, lib: 164, tests: 36, docs: 208, scripts: 351, assets: 310, infra: 87 };

function pathHash(path) {
  let value = 2166136261;
  for (const character of path) value = Math.imul(value ^ character.charCodeAt(0), 16777619);
  return value >>> 0;
}

function samePaths(first, second) {
  return Array.isArray(first) && first.length === second.length && new Set(first).size === first.length
    && first.every(path => typeof path === 'string' && second.includes(path));
}

function validModifiedPaths(declared, contentChanges, previous, current) {
  return Array.isArray(declared) && new Set(declared).size === declared.length
    && contentChanges.every(path => declared.includes(path))
    && declared.every(path => typeof path === 'string' && previous.has(path) && current.has(path));
}

export function strataColor(node, activity = 0) {
  const segments = node.path.split('/');
  let hue = node.path ? districtHues[segments[0]] ?? pathHash(segments[0]) % 360 : 43;
  for (let index = 1; index < segments.length; index += 1) {
    hue += ((pathHash(segments.slice(0, index + 1).join('/')) % 17) - 8) / 2 ** (index - 1);
  }
  const meanChanges = typeof activity === 'number' ? activity : activity?.meanChanges;
  // A fixed scale keeps older colors unchanged when a later chapter is appended.
  const intensity = Math.log1p(Math.min(8, Math.max(0, Number.isFinite(meanChanges) ? meanChanges : 0))) / Math.log1p(8);
  const saturation = .10 + intensity * .65;
  const lightness = .95 - intensity * .45;
  return { h: hue, s: saturation, l: lightness, css: `hsl(${hue} ${saturation * 100}% ${lightness * 100}%)` };
}

export function projectStrataPolygon(node, theta, phi) {
  const horizontalCosine = Math.cos(theta); const horizontalSine = Math.sin(theta);
  return (node.polygons?.flat() ?? node.polygon).map(point => {
    const horizontal = point.x - node.center.x; const vertical = point.y - node.center.y;
    return {
      x: horizontal * horizontalCosine - vertical * horizontalSine,
      y: (horizontal * horizontalSine + vertical * horizontalCosine) * Math.cos(phi),
    };
  });
}

export function strataFocusZoom(node, size, theta, phi, baseHeight = 1090) {
  const projected = projectStrataPolygon(node, theta, phi);
  const width = Math.max(1, ...projected.map(point => Math.abs(point.x) * 2));
  const height = Math.max(1, ...projected.map(point => Math.abs(point.y) * 2));
  const fit = Math.min(baseHeight * size.width / size.height / width, baseHeight / height) * .72;
  return Math.max(.05, Math.min(700, fit));
}

export function strataHomeZoom(map, size, theta, phi, baseHeight = 1090) {
  const fit = strataFocusZoom(map.root, size, theta, phi, baseHeight);
  return map.patches ? fit : Math.min(.9, fit);
}

export function strataDetailScale({ width, height, zoom, baseHeight = 1090 }) {
  // Orbiting does not change the map's granularity; perspective compression is only an entry/occupancy concern.
  return height * zoom / baseHeight * Math.max(1, 600 / Math.min(width, height));
}

function calculateStrataReadability(node, pixelsPerUnit) {
  const pixels = polygonArea(node.polygon) * pixelsPerUnit ** 2;
  const span = Math.min(node.bounds.width, node.bounds.height) * pixelsPerUnit;
  return {
    reveal: Math.max(0, Math.min(1, Math.min((pixels - 12000) / 28000, (span - 75) / 80))),
    expanded: node.type === 'folder' && node.children.length > 0 && pixels > 24000 && span > 110,
    labelFits: pixels > 2000 && span > 28,
  };
}

export function hasEnteredStrataRegion(node, { zoom, width, height, theta, phi, baseHeight = 1090, homeZoom = .9 }) {
  if (!node.id || zoom <= homeZoom * 1.08) return false;
  if (!calculateStrataReadability(node, strataDetailScale({ zoom, width, height, baseHeight })).expanded) return false;
  const polygon = projectStrataPolygon(node, theta, phi);
  const pixelsPerUnit = height * zoom / baseHeight;
  const horizontal = polygon.map(point => point.x); const vertical = polygon.map(point => point.y);
  const horizontalSpan = (Math.max(...horizontal) - Math.min(...horizontal)) * pixelsPerUnit;
  const verticalSpan = (Math.max(...vertical) - Math.min(...vertical)) * pixelsPerUnit;
  const approachZoom = strataFocusZoom(node, { width, height }, theta, phi, baseHeight);
  return zoom >= approachZoom * .92
    && Math.max(horizontalSpan, verticalSpan) >= Math.min(width, height) * .48;
}

export function buildStrataModel(history, { requireSavedMaps = false, layoutBuilder = buildBirthProjectMap } = {}) {
  if (history?.ancestry) return buildAncestralStrataModel(history, buildStrataModel);
  if (history?.schemaVersion !== 1 || !Array.isArray(history.frames) || !history.frames.length || history.frames.length > 65) {
    throw new Error('invalid-project-strata-history');
  }
  const revisions = new Set();
  const frameFiles = [];
  const frames = history.frames.map((frame, index) => {
    if (!revisionPattern.test(frame?.revision) || revisions.has(frame.revision) || !Array.isArray(frame.files)) {
      throw new Error('invalid-project-strata-history');
    }
    revisions.add(frame.revision);
    const files = new Map();
    for (const file of frame.files) {
      if (!file || files.has(file.path) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || !revisionPattern.test(file.objectId)) {
        throw new Error('invalid-project-strata-history');
      }
      files.set(file.path, { ...file });
    }
    const previous = frameFiles.at(-1);
    const added = previous ? [...files.keys()].filter(path => !previous.has(path)) : [];
    const contentChanges = previous ? [...files.keys()].filter(path => previous.has(path) && previous.get(path).objectId !== files.get(path).objectId) : [];
    const deleted = previous ? [...previous.keys()].filter(path => !files.has(path)) : [];
    const status = index === 0 ? 'baseline-unknown' : 'measured';
    // Git can report an executable-bit change with an unchanged blob. The server verifies those changes against Git.
    const validModified = previous ? validModifiedPaths(frame.changes?.modified, contentChanges, previous, files) : samePaths(frame.changes?.modified, []);
    if (frame.changes?.status !== status || !samePaths(frame.changes.added, added)
      || !validModified || !samePaths(frame.changes.deleted, deleted)) {
      throw new Error('project-strata-diff-mismatch');
    }
    const modified = [...frame.changes.modified];
    frameFiles.push(files);
    return { ...frame, files: [...files.values()], changes: { status, added, modified, deleted, comparisonRevision: frame.changes.comparisonRevision ?? null } };
  });
  const savedRecords = history.frames.map(frame => frame.mapSnapshot);
  const hasSavedMaps = savedRecords.some(Boolean);
  if ((hasSavedMaps || requireSavedMaps) && savedRecords.some(record => !record)) throw new Error('project-map-snapshot-missing');
  if (hasSavedMaps) assertVerifiedHistoryMaps(history);
  const map = hasSavedMaps ? restoreProjectMapSnapshot(savedRecords.at(-1)) : layoutBuilder({ frames, coverage: history.coverage,
    anchorRevision: history.layoutAnchor?.revision ?? history.coverage?.baselineRevision ?? frames[0].revision });
  map.coverage = history.coverage ? { ...history.coverage } : null;
  if (history.layoutAnchor?.layoutVersion && history.layoutAnchor.layoutVersion !== map.layoutVersion) throw new Error('project-map-layout-anchor-mismatch');
  const firstObserved = new Map();
  for (const [index, files] of frameFiles.entries()) for (const path of files.keys()) if (!firstObserved.has(path)) firstObserved.set(path, index);
  const cumulativeChanges = new Map();
  const activities = [];
  const states = frames.map((frame, index) => {
    const files = frameFiles[index];
    const added = new Set(frame.changes.added); const modified = new Set(frame.changes.modified); const deleted = new Set(frame.changes.deleted);
    for (const path of new Set([...added, ...modified, ...deleted])) cumulativeChanges.set(path, (cumulativeChanges.get(path) ?? 0) + 1);
    const perNode = new Map(); const perNodeActivity = new Map();
    for (const node of [...map.orderedNodes].reverse()) {
      const file = files.get(node.path) ?? null;
      const presentFiles = node.type === 'file' ? Number(Boolean(file)) : node.children.reduce((sum, id) => sum + perNode.get(id).presentFiles, 0);
      const descendantStates = node.children.map(id => perNode.get(id));
      const observedBefore = node.type === 'file' ? firstObserved.get(node.path) < index : descendantStates.some(state => state.observedBefore);
      const sum = field => descendantStates.reduce((total, state) => total + state[field], 0);
      const observedFiles = node.type === 'file' ? Number(firstObserved.get(node.path) <= index) : sum('observedFiles');
      const presence = !observedFiles ? 'absent-before-first-observation' : presentFiles === observedFiles ? 'present'
        : presentFiles ? 'mixed' : 'absent-after-observation';
      perNode.set(node.id, {
        presence, presentFiles, totalFiles: observedFiles, observedFiles, reservedFiles: node.fileCount, observedBefore,
        bytes: node.type === 'file' ? file?.bytes ?? 0 : sum('bytes'),
        added: node.type === 'file' ? Number(added.has(node.path)) : sum('added'),
        modified: node.type === 'file' ? Number(modified.has(node.path)) : sum('modified'),
        deleted: node.type === 'file' ? Number(deleted.has(node.path)) : sum('deleted'),
        changeStatus: frame.changes.status, file,
      });
      const descendantActivities = node.children.map(id => perNodeActivity.get(id));
      const changeEvents = node.type === 'file' ? cumulativeChanges.get(node.path) ?? 0
        : descendantActivities.reduce((total, activity) => total + activity.changeEvents, 0);
      const mostChanged = node.type === 'file' ? { maxChanges: changeEvents, mostChangedPath: changeEvents ? node.path : null }
        : descendantActivities.reduce((best, activity) => activity.maxChanges > best.maxChanges
          || activity.maxChanges === best.maxChanges && activity.mostChangedPath && (!best.mostChangedPath || activity.mostChangedPath < best.mostChangedPath)
          ? activity : best, { maxChanges: 0, mostChangedPath: null });
      perNodeActivity.set(node.id, {
        status: frame.changes.status, changeEvents, observedFiles,
        meanChanges: observedFiles ? changeEvents / observedFiles : 0,
        maxChanges: mostChanged.maxChanges, mostChangedPath: mostChanged.mostChangedPath,
        scaleMax: 8, unit: 'changed-pr-intervals-per-observed-file',
      });
    }
    activities.push(perNodeActivity);
    return perNode;
  });
  function validateIndex(index) {
    if (!Number.isInteger(index) || index < 0 || index >= frames.length) throw new Error('invalid-project-strata-frame');
  }
  const savedColors = hasSavedMaps ? savedRecords.map(record => new Map(record.payload.nodes.map(node => [node.id, Object.freeze({ ...node.color })]))) : null;
  const units = {
    area: '初出時の親の成長余白に住所を割り当て、後のPRが加わっても既存の場所を動かしません。面積は現在のファイル数・品質ではありません。',
    height: '1層は1つの取得済みPR統合後の版です。上が過去、下が後。厚さは一定で、工数・コード量・経過時間ではありません。',
    color: '色相は所属を継承。基準版は淡色、その後の変更を含むPR区間が多いほど濃く鮮やかになります。フォルダはその時点までに観測したファイルごとの平均（0〜8を固定尺度で表示）。基準版より前は不明。編集行数・品質の点数ではありません。',
  };
  return {
    map, frames, repository: history.repository, fetchedAt: history.fetchedAt, coverage: history.coverage, layoutAnchor: map.layoutAnchor,
    usesSavedMaps: hasSavedMaps,
    nodeState(id, index) { validateIndex(index); return states[index].get(id) ?? null; },
    activityFor(id, index) { validateIndex(index); return activities[index].get(id) ?? null; },
    colorFor(id, index) {
      validateIndex(index); const node = map.nodes.get(id);
      if (!node || node.firstObserved > index) return null;
      if (savedColors) return savedColors[index].get(id) ?? null;
      return strataColor(node, activities[index].get(id));
    },
    unitsFor(index) { validateIndex(index); return hasSavedMaps ? savedRecords[index].payload.units : units; },
    fileAt(path, index) { validateIndex(index); return frameFiles[index].get(path) ?? null; },
    changesFor(id, index) {
      validateIndex(index);
      const node = map.nodes.get(id); if (!node) return null;
      const includes = path => node.type === 'file' ? path === id : !id || path.startsWith(`${id}/`);
      const changes = frames[index].changes;
      return { status: changes.status, added: changes.added.filter(includes), modified: changes.modified.filter(includes), deleted: changes.deleted.filter(includes) };
    },
    units: hasSavedMaps ? savedRecords.at(-1).payload.units : units,
  };
}

export async function generateProjectMapSnapshots(history) {
  const sourceHistory = { ...history, frames: history.frames.map(frame => {
    const { mapSnapshot, ...source } = frame; return source;
  }) };
  const model = buildStrataModel(sourceHistory);
  const records = [];
  for (const [index, frame] of sourceHistory.frames.entries()) {
    const nodes = model.map.orderedNodes.filter(node => node.firstObserved <= index).map(node => ({
      id: node.id, path: node.path, name: node.name, type: node.type, parentId: node.parentId,
      children: node.children.filter(id => model.map.nodes.get(id).firstObserved <= index), depth: node.depth,
      fileCount: model.nodeState(node.id, index).observedFiles, firstObserved: node.firstObserved,
      birthFileCount: node.birthFileCount, allocationRound: node.allocationRound,
      polygon: node.polygon.map(point => ({ ...point })), bounds: { ...node.bounds }, center: { ...node.center },
      color: { ...model.colorFor(node.id, index) },
    }));
    const body = {
      schemaVersion: 1, repository: sourceHistory.repository, revision: frame.revision, anchorRevision: sourceHistory.frames[0].revision,
      previous: index ? { revision: records[index - 1].revision, mapDigest: records[index - 1].mapDigest } : null,
      layoutVersion: model.map.layoutVersion, colorVersion: 'activity-mean-fixed-log-1',
      sourceDigest: await digestMapValue(projectMapSource(sourceHistory, index)),
      payload: { nodes, bounds: { ...model.map.bounds }, units: { ...model.units } },
    };
    const record = { ...body, mapDigest: await digestMapValue(body) };
    validateProjectMapSnapshot(record);
    if (history.frames[index].mapSnapshot && canonicalMapJson(history.frames[index].mapSnapshot) !== canonicalMapJson(record)) throw new Error('project-map-snapshot-conflict');
    records.push(record);
  }
  validateMapSnapshotContinuity(records);
  return records;
}

export function strataDetail(map, pixelsPerUnit) {
  const detail = new Map([['', { opacity: 1, expanded: true, label: false }]]);
  for (const node of map.orderedNodes) {
    if (!node.id || node.parentId === null) { detail.set(node.id, { opacity: 1, expanded: true, label: false }); continue; }
    const parent = map.nodes.get(node.parentId);
    const parentDetail = detail.get(parent.id);
    const reveal = parent.parentId !== null ? calculateStrataReadability(parent, pixelsPerUnit).reveal : 1;
    const opacity = parentDetail.opacity * reveal;
    const readability = calculateStrataReadability(node, pixelsPerUnit);
    detail.set(node.id, {
      opacity,
      expanded: readability.expanded,
      label: opacity > .65 && readability.labelFits,
    });
  }
  return detail;
}
