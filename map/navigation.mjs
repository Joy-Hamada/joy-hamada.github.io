import { polygonArea, containsPoint, traceProjectMapAncestors } from './model.mjs';
import { projectRectangle, intersectsViewport, fitRectangle, screenToWorld } from '../mosaic/viewport.mjs';

const openingArea = 67000;
const openingSpan = 150;
const topLevelOpeningScale = 1.45;

export function focusProjectMapRegion(node, size, homeScale) {
  let minimum = homeScale * (node.id ? 1.5 : .7);
  if (node.id && node.type === 'folder' && node.children.length) {
    // Fitting a tall district on a narrow screen can keep it closed; entry must satisfy every opening condition.
    minimum = Math.max(minimum,
      Math.sqrt(openingArea / polygonArea(node.polygon)) * 1.02,
      openingSpan / Math.min(node.bounds.width, node.bounds.height) * 1.02,
      node.depth === 1 ? homeScale * topLevelOpeningScale * 1.02 : 0);
  }
  return fitRectangle(node.bounds, size, { padding: node.id ? 78 : 50, minimum, maximum: Math.max(homeScale * 500, minimum) });
}

export function selectProjectMapDetail(map, view, size, previous = new Set(), homeScale = 1) {
  const frontier = []; const frames = []; const expanded = new Set();
  // Culling must not erase hysteresis: revisiting the same camera position should retain its detail.
  for (const node of map.orderedNodes) {
    const rectangle = projectRectangle(view, node.bounds);
    const wasOpen = previous.has(node.id);
    const pixels = polygonArea(node.polygon) * view.scale ** 2;
    const threshold = wasOpen ? 43000 : openingArea;
    const openingScale = node.depth === 1 ? (wasOpen ? 1.18 : topLevelOpeningScale) : 0;
    const open = node.type === 'folder' && node.children.length > 0 &&
      (node.id === '' || (pixels >= threshold && Math.min(rectangle.width, rectangle.height) > (wasOpen ? 120 : openingSpan) && view.scale / homeScale >= openingScale));
    if (open) expanded.add(node.id);
  }
  function visit(node) {
    if (!intersectsViewport(projectRectangle(view, node.bounds), size)) return;
    if (expanded.has(node.id)) {
      frames.push(node);
      for (const id of node.children) visit(map.nodes.get(id));
    } else frontier.push(node);
  }
  visit(map.root);
  return { frontier, frames, expanded };
}

export function locateProjectMapRegion(map, frames, view, size) {
  const center = screenToWorld(view, { x: size.width / 2, y: size.height / 2 });
  let region = map.root;
  // Closed frontier regions describe what can be entered, not the region the camera has entered.
  for (const frame of frames) {
    if (frame.type === 'folder' && frame.depth > region.depth && containsPoint(frame.polygon, center)) region = frame;
  }
  return region;
}

export function buildProjectMapContext(map, regionId, focusId = null) {
  const requested = map.nodes.get(regionId);
  const region = requested?.type === 'folder' ? requested : map.root;
  const ancestors = traceProjectMapAncestors(map, region.id);
  const focus = map.nodes.get(focusId);
  return ancestors.map((node, index) => {
    const nextRegion = ancestors[index + 1];
    // A retained selection elsewhere must not turn a context lens into a false ancestry relation.
    const focusedChild = focus?.type === 'file' && focus.parentId === node.id ? focus.id : null;
    return { node, nextChildId: nextRegion ? nextRegion.id : focusedChild };
  });
}

export function constrainProjectMapViewport(view, bounds, size, margin = 90) {
  function constrainOffset(offset, start, length, viewport) {
    const extent = length * view.scale;
    const visibleMargin = Math.min(margin, viewport * .2, extent);
    const minimum = visibleMargin - (start + length) * view.scale;
    const maximum = viewport - visibleMargin - start * view.scale;
    return Math.max(minimum, Math.min(maximum, offset));
  }
  // Recentring a short map axis would move the camera away from the region the user just entered.
  return { ...view,
    x: constrainOffset(view.x, bounds.x, bounds.width, size.width),
    y: constrainOffset(view.y, bounds.y, bounds.height, size.height),
  };
}

const districtHues = { apps: 272, lib: 171, tests: 32, docs: 213, scripts: 358, assets: 315, infra: 79 };
function pathHash(path) { let value = 2166136261; for (const char of path) value = Math.imul(value ^ char.charCodeAt(0), 16777619); return value >>> 0; }

export function projectMapColor(node) {
  if (!node.path) return 'hsl(43 25% 94%)';
  const top = node.path.split('/')[0];
  const hue = districtHues[top] ?? (pathHash(top) % 360);
  const variation = node.depth > 1 ? pathHash(node.path) % 13 - 6 : 0;
  return `hsl(${hue + variation} ${36 + Math.min(node.depth, 6) * 3}% ${82 - Math.min(node.depth, 7) * 1.5 + (pathHash(node.path) % 3)}%)`;
}

export function resolveProjectMapHash(hash, map) {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const revision = params.get('revision');
  const path = params.get('path') ?? '';
  if (revision && revision !== map.revision) return { path: '', error: 'このリンクは別の版です。現在の地図の全体を表示しています。' };
  if (!map.nodes.has(path)) return { path: '', error: '指定した場所はこの版の表示範囲にありません。' };
  return { path, error: null };
}

export function describeProjectMapPath(map, id) {
  return traceProjectMapAncestors(map, id).map(node => node.id ? node.name : 'XOZU').join(' / ');
}

export function createLatestProjectMapReader(read) {
  let sequence = 0; let controller;
  return {
    cancel() { sequence += 1; controller?.abort(); },
    async request(selection) {
      controller?.abort(); controller = new AbortController();
      const ticket = ++sequence;
      try {
        const value = await read(selection, controller.signal);
        return ticket === sequence ? { status: 'ready', value } : { status: 'stale' };
      } catch (error) {
        return ticket === sequence ? { status: 'error', error } : { status: 'stale' };
      }
    },
  };
}
