import { containsPoint } from './model.mjs';

export const flatScaleLimits = Object.freeze({ minimum: 1e-6, maximum: 1024 });
export const flatUsableViewportMinimum = 96;
export const isFlatViewportUsable = viewport => viewport.right - viewport.left >= flatUsableViewportMinimum
  && viewport.bottom - viewport.top >= flatUsableViewportMinimum;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
export const flatViewportCenter = viewport => ({ x: (viewport.left + viewport.right) / 2, y: (viewport.top + viewport.bottom) / 2 });

export function normalizeFlatViewport(bounds, size) {
  const requested = bounds ?? { left: 0, top: 0, right: size.width, bottom: size.height };
  if (!['left', 'top', 'right', 'bottom'].every(key => Number.isFinite(requested[key]))) throw new Error('invalid-flat-viewport');
  const left = clamp(requested.left, 0, size.width); const top = clamp(requested.top, 0, size.height);
  return { left, top, right: Math.max(left, clamp(requested.right, 0, size.width)), bottom: Math.max(top, clamp(requested.bottom, 0, size.height)) };
}

export function projectFlatPoint(camera, point) {
  const center = flatViewportCenter(camera.viewport);
  return { x: center.x + (point.x - camera.center.x) * camera.scale, y: center.y + (point.y - camera.center.y) * camera.scale };
}

export function unprojectFlatPoint(camera, point) {
  const center = flatViewportCenter(camera.viewport);
  return { x: camera.center.x + (point.x - center.x) / camera.scale, y: camera.center.y + (point.y - center.y) / camera.scale };
}

export function fitFlatCamera(node, viewport, margin = .78) {
  const points = node.polygons?.flat() ?? node.polygon;
  const minX = Math.min(...points.map(point => point.x)); const maxX = Math.max(...points.map(point => point.x));
  const minY = Math.min(...points.map(point => point.y)); const maxY = Math.max(...points.map(point => point.y));
  const scale = Math.min(Math.max(1, viewport.right - viewport.left) / Math.max(1e-6, maxX - minX),
    Math.max(1, viewport.bottom - viewport.top) / Math.max(1e-6, maxY - minY)) * margin;
  return { center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    scale: clamp(scale, flatScaleLimits.minimum, flatScaleLimits.maximum), viewport: { ...viewport } };
}

export function panFlatCamera(camera, from, to) {
  return { ...camera, center: { x: camera.center.x + (from.x - to.x) / camera.scale, y: camera.center.y + (from.y - to.y) / camera.scale } };
}

export function zoomFlatCamera(camera, factor, anchor = flatViewportCenter(camera.viewport), limits = flatScaleLimits) {
  if (!Number.isFinite(factor) || factor <= 0) return camera;
  const before = unprojectFlatPoint(camera, anchor);
  const next = { ...camera, scale: clamp(camera.scale * factor, limits.minimum, limits.maximum) };
  const after = unprojectFlatPoint(next, anchor);
  return { ...next, center: { x: next.center.x + before.x - after.x, y: next.center.y + before.y - after.y } };
}

export function reframeFlatViewport(camera, viewport) {
  const before = flatViewportCenter(camera.viewport); const after = flatViewportCenter(viewport);
  return { ...camera, viewport: { ...viewport }, center: { x: camera.center.x + (after.x - before.x) / camera.scale,
    y: camera.center.y + (after.y - before.y) / camera.scale } };
}

export function flatNodeLabel(node, state) {
  return `${node.name}-${state?.presentFiles ?? 0}`;
}

export function pickFlatNode(map, detail, point, frameIndex) {
  let selected = null;
  for (const node of map.orderedNodes) {
    if ((node.firstObserved ?? 0) > frameIndex || (detail.get(node.id)?.opacity ?? 0) <= .55) continue;
    if ((!selected || node.depth >= selected.depth) && containsPoint(node.polygon, point)) selected = node;
  }
  return selected;
}
