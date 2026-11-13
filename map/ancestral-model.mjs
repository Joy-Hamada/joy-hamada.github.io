import { readVerifiedAncestralLayouts } from './ancestral-history.mjs';
import { polygonBounds, polygonCenter } from './model.mjs';

export function buildAncestralStrataModel(history, buildLegacyModel) {
  const { layouts, records, ordinals } = readVerifiedAncestralLayouts(history);
  const frameOrdinals = history.frames.map(frame => ordinals.get(frame.revision));
  const appearedAt = ordinal => {
    const index = frameOrdinals.findIndex(value => value >= ordinal); return index < 0 ? history.frames.length : index;
  };
  const maps = history.frames.map(frame => {
    const source = layouts.get(frame.revision).map;
    const orderedNodes = source.orderedNodes.map(node => ({ ...node, firstObserved: appearedAt(node.firstObserved) }));
    const nodes = new Map(orderedNodes.map(node => [node.id, node]));
    return { ...source, nodes, orderedNodes, root: nodes.get(''),
      patches: source.patches.map(patch => ({ ...patch, firstObserved: appearedAt(ordinals.get(patch.revision)) })) };
  });
  const source = { ...history, ancestry: undefined, ancestralMaps: undefined, layoutAnchor: undefined,
    frames: history.frames.map(({ mapSnapshot, ...frame }) => frame) };
  const base = buildLegacyModel(source, { layoutBuilder: () => maps.at(-1) });
  function resultAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= maps.length) throw new Error('invalid-project-strata-frame');
    return layouts.get(history.frames[index].revision);
  }
  return { ...base, frames: base.frames.map((frame, index) => ({ ...frame, mapSnapshot: records[index] })),
    usesSavedMaps: false, usesAncestralMaps: true,
    mapFor(index) { resultAt(index); return maps[index]; },
    colorFor(id, index) { return resultAt(index).colors.get(id) ?? null; },
    activityFor(id, index) { return resultAt(index).activities.get(id) ?? null; },
    nodeState(id, index) {
      const state = base.nodeState(id, index); if (!state) return null;
      const node = maps[index].nodes.get(id);
      return { ...state, observedFiles: node?.fileCount ?? 0, totalFiles: node?.fileCount ?? 0,
        presence: state.presentFiles ? state.presentFiles < node.fileCount ? 'mixed' : 'present' : node ? 'absent-after-observation' : 'absent-before-first-observation' };
    },
    units: layouts.get(history.frames.at(-1).revision).units,
    unitsFor(index) { return resultAt(index).units; },
  };
}

// Each growth plot repeats the hierarchy inside its own ground. Its logical path remains one folder.
export function expandStrataRegions(map) {
  if (!map.patches) return map;
  const patchById = new Map(map.patches.map(patch => [patch.id, patch]));
  const orderedNodes = []; const nodes = new Map();
  for (const node of map.orderedNodes) for (const region of node.regions) {
    const patch = patchById.get(region.patchId);
    const id = JSON.stringify([node.id, region.patchId]);
    const parentId = node.parentId === null ? null : JSON.stringify([node.parentId, region.patchId]);
    const visual = { ...node, id, logicalId: node.id, patchId: region.patchId, parentId,
      polygon: region.polygon, polygons: [region.polygon], bounds: polygonBounds(region.polygon), center: polygonCenter(region.polygon),
      children: node.children.filter(child => map.nodes.get(child).regions.some(candidate => candidate.patchId === region.patchId))
        .map(child => JSON.stringify([child, region.patchId])), firstObserved: patch.firstObserved };
    nodes.set(id, visual); orderedNodes.push(visual);
  }
  return { ...map, nodes, orderedNodes };
}
