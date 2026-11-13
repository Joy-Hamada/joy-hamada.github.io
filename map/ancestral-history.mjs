import { buildAncestralLayouts, ancestralColorVersion } from './ancestral-layout.mjs';
import { canonicalMapJson, digestMapValue } from './map-snapshot.mjs';

const verified = new WeakMap();
const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const signature = history => canonicalMapJson({ ancestry: history.ancestry, frames: history.frames, ancestralMaps: history.ancestralMaps });

async function derive(history) {
  const ancestry = history?.ancestry;
  if (history.schemaVersion !== 1 || ancestry?.policy !== 'first-parent-root-v1' || !Array.isArray(ancestry.commits)
    || !ancestry.commits.length || ancestry.commits.length > 1000 || !Array.isArray(history.frames) || !history.frames.length || history.frames.length > 65
    || ancestry.rootRevision !== ancestry.commits[0].revision || ancestry.headRevision !== ancestry.commits.at(-1).revision) throw new Error('project-ancestry-invalid');
  const commits = new Map(); let previous = null; let inventoryRows = 0;
  for (const commit of ancestry.commits) {
    if (!revisionPattern.test(commit.revision) || commits.has(commit.revision) || commit.parentRevision !== previous
      || !Array.isArray(commit.parents) || commit.parents.some(parent => !revisionPattern.test(parent))
      || new Set(commit.parents).size !== commit.parents.length || (commit.parents[0] ?? null) !== previous
      || !Array.isArray(commit.files) || (inventoryRows += commit.files.length) > 500000) throw new Error('project-ancestry-incomplete');
    commits.set(commit.revision, commit); previous = commit.revision;
  }
  const layouts = buildAncestralLayouts({ commits: ancestry.commits });
  const proofs = new Map(); let parentDigest = null;
  for (const commit of ancestry.commits) {
    const result = layouts.get(commit.revision);
    const sourceDigest = await digestMapValue({ repository: history.repository, policy: ancestry.policy, parentDigest,
      revision: commit.revision, parents: commit.parents, files: [...commit.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0) });
    const payload = { nodes: result.map.orderedNodes.map(node => ({ ...node, color: result.colors.get(node.id) })),
      patches: result.map.patches, bounds: result.map.bounds, units: result.units };
    const record = { revision: commit.revision, sourceDigest, layoutVersion: result.map.layoutVersion, colorVersion: ancestralColorVersion };
    const proof = { ...record, mapDigest: await digestMapValue({ ...record, payload }) };
    proofs.set(commit.revision, proof); parentDigest = sourceDigest;
  }
  let lastOrdinal = -1; const ordinals = new Map(ancestry.commits.map((commit, index) => [commit.revision, index]));
  const records = history.frames.map(frame => {
    const commit = commits.get(frame.revision); const ordinal = ordinals.get(frame.revision);
    if (!commit || ordinal <= lastOrdinal || canonicalMapJson(frame.files) !== canonicalMapJson(commit.files)) throw new Error('project-ancestry-frame-mismatch');
    lastOrdinal = ordinal; return proofs.get(frame.revision);
  });
  return { layouts, records, ordinals };
}

export async function attachAncestralMaps(history) {
  const { records } = await derive(history);
  return { ...history, ancestralMaps: records };
}

export async function verifyAncestralHistory(history) {
  const result = await derive(history);
  if (canonicalMapJson(history.ancestralMaps) !== canonicalMapJson(result.records)) throw new Error('project-ancestry-map-mismatch');
  verified.set(history, { ...result, signature: signature(history) });
  return true;
}

export function readVerifiedAncestralLayouts(history) {
  const result = verified.get(history);
  if (!result || result.signature !== signature(history)) throw new Error('project-ancestry-not-verified');
  return result;
}
