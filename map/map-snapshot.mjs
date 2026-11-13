import { containsPoint, polygonArea, polygonBounds, validateFile } from './model.mjs';

const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const digestPattern = /^[a-f0-9]{64}$/;
const verifiedHistories = new WeakMap();
const maximumNodes = 250000;
const colorFields = ['h', 's', 'l', 'css'];
const nodeFields = ['id', 'path', 'name', 'type', 'parentId', 'children', 'depth', 'fileCount', 'firstObserved', 'birthFileCount', 'allocationRound', 'polygon', 'bounds', 'center', 'color'];

function fail(reason = 'invalid') { throw new Error(`project-map-snapshot-${reason}`); }
function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
function exactFields(value, fields) {
  if (!isObject(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail();
}
function nonnegativeInteger(value) { return Number.isSafeInteger(value) && value >= 0; }
function close(first, second) { return Math.abs(first - second) <= 1e-7 * Math.max(1, Math.abs(first), Math.abs(second)); }
function validPoint(point) {
  exactFields(point, ['x', 'y']);
  if (![point.x, point.y].every(value => Number.isFinite(value) && Math.abs(value) <= 1e7)) fail();
}
function validateBounds(bounds, polygon) {
  exactFields(bounds, ['x', 'y', 'width', 'height']);
  const calculated = polygonBounds(polygon);
  if (Object.keys(calculated).some(key => !Number.isFinite(bounds[key]) || !close(bounds[key], calculated[key]))) fail();
}
function validatePolygon(polygon) {
  if (!Array.isArray(polygon) || polygon.length < 3 || polygon.length > 128) fail();
  polygon.forEach(validPoint);
  if (!(polygonArea(polygon) > 1e-8)) fail();
  let positive = false; let negative = false;
  for (let index = 0; index < polygon.length; index += 1) {
    const first = polygon[index]; const second = polygon[(index + 1) % polygon.length]; const third = polygon[(index + 2) % polygon.length];
    const cross = (second.x - first.x) * (third.y - second.y) - (second.y - first.y) * (third.x - second.x);
    if (cross > 1e-8) positive = true;
    if (cross < -1e-8) negative = true;
    if (positive && negative) fail();
  }
}
function validateColor(color) {
  exactFields(color, colorFields);
  if (!Number.isFinite(color.h) || Math.abs(color.h) > 3600 || !Number.isFinite(color.s) || color.s < 0 || color.s > 1
    || !Number.isFinite(color.l) || color.l < 0 || color.l > 1
    || color.css !== `hsl(${color.h} ${color.s * 100}% ${color.l * 100}%)`) fail();
}

export function canonicalMapJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalMapJson).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalMapJson(value[key])}`).join(',')}}`;
  fail();
}

export async function digestMapValue(value) {
  if (!globalThis.crypto?.subtle) fail('verification-unavailable');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalMapJson(value)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function projectMapSource(history, index) {
  const frame = history?.frames?.[index];
  if (!frame || !Number.isInteger(index) || index < 0 || typeof history.repository !== 'string') fail('source-invalid');
  const coverage = frame.coverage ?? {};
  const changes = frame.changes ?? {};
  return {
    repository: history.repository, revision: frame.revision, anchorRevision: history.frames[0].revision,
    previousRevision: index ? history.frames[index - 1].revision : null,
    files: frame.files.map(file => ({ id: file.path, path: file.path, kind: file.kind ?? null, bytes: file.bytes, objectId: file.objectId }))
      .sort((first, second) => first.path < second.path ? -1 : first.path > second.path ? 1 : 0),
    changes: {
      status: changes.status, added: [...(changes.added ?? [])].sort(), modified: [...(changes.modified ?? [])].sort(), deleted: [...(changes.deleted ?? [])].sort(),
      comparisonRevision: changes.comparisonRevision ?? (index ? history.frames[index - 1].revision : null),
      interveningCommits: [...(changes.interveningCommits ?? [])], attribution: changes.attribution ?? null,
    },
    coverage: {
      trackedFiles: coverage.trackedFiles ?? null, includedFiles: coverage.includedFiles ?? frame.files.length,
      excludedFiles: coverage.excludedFiles ?? null, completeWithinScope: coverage.completeWithinScope ?? null,
    },
  };
}

export function validateProjectMapSnapshot(record) {
  exactFields(record, ['schemaVersion', 'repository', 'revision', 'anchorRevision', 'previous', 'layoutVersion', 'colorVersion', 'sourceDigest', 'mapDigest', 'payload']);
  if (record.schemaVersion !== 1 || typeof record.repository !== 'string' || !record.repository || record.repository.length > 200
    || !revisionPattern.test(record.revision) || !revisionPattern.test(record.anchorRevision)
    || !digestPattern.test(record.sourceDigest) || !digestPattern.test(record.mapDigest)
    || ![record.layoutVersion, record.colorVersion].every(value => typeof value === 'string' && /^[a-z0-9][a-z0-9.-]{0,79}$/i.test(value))) fail();
  if (record.previous !== null) {
    exactFields(record.previous, ['revision', 'mapDigest']);
    if (!revisionPattern.test(record.previous.revision) || !digestPattern.test(record.previous.mapDigest) || record.previous.revision === record.revision) fail();
  }
  exactFields(record.payload, ['nodes', 'bounds', 'units']);
  if (!Array.isArray(record.payload.nodes) || !record.payload.nodes.length || record.payload.nodes.length > maximumNodes) fail();
  exactFields(record.payload.units, ['area', 'height', 'color']);
  if (Object.values(record.payload.units).some(value => typeof value !== 'string' || !value || value.length > 4000)) fail();
  const nodes = new Map();
  for (const node of record.payload.nodes) {
    exactFields(node, nodeFields);
    if (typeof node.id !== 'string' || node.path !== node.id || nodes.has(node.id) || !['folder', 'file'].includes(node.type)
      || typeof node.name !== 'string' || !node.name || node.name.length > 2000 || !Array.isArray(node.children)
      || node.children.some(id => typeof id !== 'string') || new Set(node.children).size !== node.children.length
      || ![node.depth, node.fileCount, node.firstObserved, node.birthFileCount, node.allocationRound].every(nonnegativeInteger)
      || node.firstObserved > 64 || node.allocationRound > 64) fail();
    if (node.id) {
      try { validateFile({ path: node.id }); } catch { fail(); }
      const parts = node.id.split('/');
      if (node.parentId !== parts.slice(0, -1).join('/') || node.depth !== parts.length || node.name !== parts.at(-1)) fail();
    } else if (node.parentId !== null || node.depth !== 0 || node.type !== 'folder' || node.firstObserved !== 0) fail();
    if (node.type === 'file' && (node.children.length || node.fileCount !== 1)) fail();
    validatePolygon(node.polygon); validateBounds(node.bounds, node.polygon); validPoint(node.center);
    if (!containsPoint(node.polygon, node.center)) fail();
    validateColor(node.color); nodes.set(node.id, node);
  }
  const root = nodes.get(''); if (!root) fail();
  validateBounds(record.payload.bounds, root.polygon);
  const children = new Map([...nodes.keys()].map(id => [id, []]));
  for (const node of nodes.values()) if (node.parentId !== null) {
    const parent = nodes.get(node.parentId);
    if (!parent || parent.type !== 'folder' || parent.firstObserved > node.firstObserved || node.polygon.some(point => !containsPoint(parent.polygon, point))) fail();
    children.get(parent.id).push(node.id);
  }
  for (const node of nodes.values()) {
    if (canonicalMapJson(node.children) !== canonicalMapJson(children.get(node.id).sort())) fail();
    if (node.type === 'folder' && node.fileCount !== node.children.reduce((sum, id) => sum + nodes.get(id).fileCount, 0)) fail();
  }
  return record;
}

function identity(node) {
  const { id, path, name, type, parentId, depth, firstObserved, birthFileCount, allocationRound, polygon, bounds, center } = node;
  return { id, path, name, type, parentId, depth, firstObserved, birthFileCount, allocationRound, polygon, bounds, center };
}

export function validateMapSnapshotContinuity(records) {
  if (!Array.isArray(records) || !records.length || records.length > 65) fail('missing');
  const revisions = new Set();
  for (const [index, record] of records.entries()) {
    validateProjectMapSnapshot(record);
    if (revisions.has(record.revision)) fail('chain-mismatch');
    revisions.add(record.revision);
    const previous = records[index - 1];
    if (!previous) {
      if (record.previous !== null || record.revision !== record.anchorRevision) fail('chain-mismatch');
      continue;
    }
    if (record.repository !== previous.repository || record.anchorRevision !== previous.anchorRevision
      || record.previous?.revision !== previous.revision || record.previous?.mapDigest !== previous.mapDigest) fail('chain-mismatch');
    const nodes = new Map(record.payload.nodes.map(node => [node.id, node]));
    for (const node of previous.payload.nodes) {
      if (!nodes.has(node.id) || canonicalMapJson(identity(node)) !== canonicalMapJson(identity(nodes.get(node.id)))) fail('address-conflict');
    }
  }
}

function sourceSignature(history) {
  return canonicalMapJson(history.frames.map((frame, index) => ({ source: projectMapSource(history, index), mapSnapshot: frame.mapSnapshot })));
}

export async function verifyHistoryMapSnapshots(history) {
  if (!Array.isArray(history?.frames) || !history.frames.length || history.frames.length > 65) fail('missing');
  const records = history.frames.map(frame => frame.mapSnapshot);
  if (records.some(record => !record)) fail('missing');
  validateMapSnapshotContinuity(records);
  const observed = new Map([['', { type: 'folder', firstObserved: 0 }]]);
  for (const [index, frame] of history.frames.entries()) {
    const record = records[index];
    if (record.repository !== history.repository || record.revision !== frame.revision || record.anchorRevision !== history.frames[0].revision) fail('source-mismatch');
    if (record.sourceDigest !== await digestMapValue(projectMapSource(history, index))) fail('source-mismatch');
    const { mapDigest, ...body } = record;
    if (mapDigest !== await digestMapValue(body)) fail('digest-mismatch');
    for (const file of frame.files) {
      try { validateFile(file); } catch { fail('source-invalid'); }
      const parts = file.path.split('/');
      for (let length = 1; length <= parts.length; length += 1) {
        const path = parts.slice(0, length).join('/'); const type = length === parts.length ? 'file' : 'folder';
        if (observed.has(path) && observed.get(path).type !== type) fail('source-mismatch');
        if (!observed.has(path)) observed.set(path, { type, firstObserved: index });
      }
    }
    if (record.payload.nodes.length !== observed.size) fail('source-mismatch');
    for (const node of record.payload.nodes) {
      const expected = observed.get(node.id);
      if (!expected || node.type !== expected.type || node.firstObserved !== expected.firstObserved) fail('source-mismatch');
    }
  }
  verifiedHistories.set(history, sourceSignature(history));
  return history;
}

export function assertVerifiedHistoryMaps(history) {
  if (!verifiedHistories.has(history) || verifiedHistories.get(history) !== sourceSignature(history)) fail('unverified');
}

export function restoreProjectMapSnapshot(record) {
  validateProjectMapSnapshot(record);
  const nodes = new Map(record.payload.nodes.map(node => [node.id, structuredClone(node)]));
  const root = nodes.get(''); const orderedNodes = []; const pending = [root];
  while (pending.length) {
    const node = pending.pop(); orderedNodes.push(node);
    for (let index = node.children.length - 1; index >= 0; index -= 1) pending.push(nodes.get(node.children[index]));
  }
  return { root, nodes, orderedNodes, bounds: { ...record.payload.bounds }, revision: record.revision,
    layoutVersion: record.layoutVersion, layoutAnchor: { revision: record.anchorRevision, layoutVersion: record.layoutVersion },
    units: structuredClone(record.payload.units), coverage: null };
}
