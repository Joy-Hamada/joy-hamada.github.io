const revisionPattern = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digestPattern = /^[a-f0-9]{64}$/;
const recordPattern = /^docs\/(?:issues|decisions|spec-driven-dev\/(?:req|design|tasks|dev-report))\/[A-Za-z0-9._-]+\.md$/;
export const maximumRecordResourceBytes = 64 * 1024 * 1024;
const maximumDocuments = 256;
const maximumDocumentBytes = 256 * 1024;
const maximumOriginalBytes = 16 * 1024 * 1024;

function fail(reason) { throw new Error(`record-resource-${reason}`); }

function validateResource(frame) {
  const resource = frame.recordResource;
  if (!revisionPattern.test(frame.revision) || resource?.url !== `/records/${frame.revision}.json`
    || !digestPattern.test(resource.sha256) || !Number.isSafeInteger(resource.bytes) || resource.bytes < 1
    || resource.bytes > maximumRecordResourceBytes) fail('descriptor');
  return { ...resource };
}

function validatePayload(payload, frame) {
  if (payload?.schemaVersion !== 1 || payload.revision !== frame.revision || !Array.isArray(payload.documents)
    || payload.documents.length > maximumDocuments || payload.trace?.schemaVersion !== 1 || payload.trace.revision !== frame.revision
    || !Array.isArray(payload.trace.nodes) || !Array.isArray(payload.trace.edges)) fail('payload');
  const files = new Set(frame.files.map(file => file.path)); const seen = new Set(); let bytes = 0;
  for (const document of payload.documents) {
    if (!recordPattern.test(document?.path) || !files.has(document.path) || seen.has(document.path)
      || document.revision !== frame.revision || typeof document.content !== 'string' || document.content.includes('\0')) fail('document');
    const size = new TextEncoder().encode(document.content).length; bytes += size;
    if (size > maximumDocumentBytes || bytes > maximumOriginalBytes) fail('document-size');
    seen.add(document.path);
  }
  if (payload.trace.nodes.some(node => node.revision && node.revision !== frame.revision)
    || payload.trace.edges.some(edge => edge.proof?.revision && edge.proof.revision !== frame.revision)) fail('trace-revision');
  return payload;
}

async function readResourceBytes(response, expectedBytes) {
  if (!response.ok || response.redirected) fail('unavailable');
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectedBytes) fail('size');
    return bytes;
  }
  const chunks = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > expectedBytes) { await reader.cancel(); fail('size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  if (length !== expectedBytes) fail('size');
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

export function createRecordLoader({ fetchResource = globalThis.fetch } = {}) {
  let sequence = 0; let controller; const cache = new Map();
  function cancel() { sequence += 1; controller?.abort(); }
  return {
    cancel,
    clear() { cancel(); cache.clear(); },
    async request(frame) {
      cancel(); const ticket = sequence; controller = new AbortController();
      if (!frame.recordResource) return { status: 'ready', value: { schemaVersion: 1, revision: frame.revision, documents: frame.story?.documents ?? [], trace: frame.trace } };
      try {
        const resource = validateResource(frame); const key = `${frame.revision}:${resource.sha256}:${resource.bytes}`;
        let payload = cache.get(key);
        if (!payload) {
          const response = await fetchResource(resource.url, { signal: controller.signal, redirect: 'error', credentials: 'same-origin' });
          const bytes = await readResourceBytes(response, resource.bytes);
          const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
          const sha256 = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
          if (sha256 !== resource.sha256) fail('digest');
          payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        validatePayload(payload, frame);
        if (ticket !== sequence) return { status: 'stale' };
        cache.delete(key); cache.set(key, payload);
        while (cache.size > 2) cache.delete(cache.keys().next().value);
        return { status: 'ready', value: payload };
      } catch (error) { return ticket === sequence ? { status: 'error', error } : { status: 'stale' }; }
    },
  };
}

// The history verifier owns its input objects; hydration belongs to the already-built display model.
export function applyFrameRecords(frame, payload) {
  validatePayload(payload, frame);
  frame.story = { ...frame.story, documents: payload.documents };
  frame.trace = payload.trace;
}

export function releaseFrameRecords(frame) {
  if (!frame?.recordResource) return;
  frame.story = { ...frame.story }; delete frame.story.documents; delete frame.trace;
}
