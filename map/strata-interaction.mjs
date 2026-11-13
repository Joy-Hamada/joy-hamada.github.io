export const strataLayerThickness = 18;
export const strataLayerGap = 46;
export const mapGestureThresholds = Object.freeze({
  settleMilliseconds: 80, coherentMovementPixels: 4, minimumSeparationPixels: 12,
  zoomRatio: .045, zoomDistancePixels: 6, stableSeparationRatio: .035,
  tiltDistancePixels: 10, tiltFingerDistancePixels: 8, tiltAngleDegrees: 8, tiltDegreesPerPixel: .22,
  parallelHorizontalPixels: 8, parallelHorizontalRatio: .4, parallelDifferencePixels: 12, parallelDifferenceRatio: .35,
  rotationDegrees: 14, panDistancePixels: 8, tapMovementPixels: 4,
});

export function strataLayerBase(index, selectedIndex, exploded = false) {
  return (selectedIndex - index) * (strataLayerThickness + (exploded ? strataLayerGap : 0)) - strataLayerThickness;
}

export function classifyStrataSwipe({ start, end, multi = false, cancelled = false }) {
  if (multi || cancelled || !start || !end) return 0;
  const horizontal = end.x - start.x; const vertical = end.y - start.y;
  if (!Number.isFinite(horizontal) || !Number.isFinite(vertical)
    || Math.abs(vertical) < 48 || Math.abs(vertical) < Math.abs(horizontal) * 1.4) return 0;
  return vertical < 0 ? 1 : -1;
}

export function createMapPointerGesture({ rotate = false, tilt = false, coalesce = false, now = () => performance.now() } = {}) {
  const pointers = new Map();
  let gesture = null; let pairGesture = null;
  const middle = pair => ({ x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 });
  const distance = pair => Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
  const angle = pair => Math.atan2(pair[1].y - pair[0].y, pair[1].x - pair[0].x);
  const angleDelta = (after, before) => Math.atan2(Math.sin(angle(after) - angle(before)), Math.cos(angle(after) - angle(before))) * 180 / Math.PI;
  const valid = point => Number.isFinite(point?.x) && Number.isFinite(point?.y);
  const snapshot = () => [...pointers.values()].map(point => ({ ...point }));
  const thresholds = mapGestureThresholds;
  const beginPair = () => ({ start: snapshot(), reported: snapshot(), batchStart: snapshot(), rotationPair: snapshot(), zoomDistance: distance(snapshot()),
    changed: new Set(), mode: null, dirty: false, dirtyAt: null });
  function flushPair(settle = false) {
    if (pointers.size !== 2 || !pairGesture?.dirty) return null;
    const pair = pairGesture; const after = snapshot(); const start = pair.start;
    const moved = after.map((point, index) => Math.hypot(point.x - pair.batchStart[index].x, point.y - pair.batchStart[index].y));
    const bothUpdated = pair.changed.size === 2;
    const coherent = bothUpdated && (moved.every(value => value >= thresholds.coherentMovementPixels)
      || moved.every(value => value < thresholds.coherentMovementPixels));
    // Counting frames or remembering old pointer updates misclassifies the first half of a later parallel swipe.
    if (!settle && (!pair.mode || pair.mode === 'pan') && !coherent && now() - pair.dirtyAt < thresholds.settleMilliseconds) return null;
    pair.dirty = false; pair.dirtyAt = null; pair.changed.clear(); pair.batchStart = after;
    const initialDistance = distance(start); const currentDistance = distance(after);
    if (initialDistance < thresholds.minimumSeparationPixels || currentDistance < thresholds.minimumSeparationPixels) return null;
    const delta = after.map((point, index) => ({ x: point.x - start[index].x, y: point.y - start[index].y }));
    const scaleChange = Math.abs(currentDistance / initialDistance - 1);
    const rotation = angleDelta(after, start);
    const vertical = middle(after).y - middle(start).y;
    const parallelVertical = delta.every(point => Math.abs(point.x) <= Math.max(thresholds.parallelHorizontalPixels, Math.abs(point.y) * thresholds.parallelHorizontalRatio))
      && delta[0].y * delta[1].y > 0
      && Math.abs(delta[0].y - delta[1].y) <= Math.max(thresholds.parallelDifferencePixels, Math.abs(vertical) * thresholds.parallelDifferenceRatio);
    if (!pair.mode || pair.mode === 'pan') {
      if (scaleChange >= thresholds.zoomRatio && Math.abs(currentDistance - initialDistance) >= thresholds.zoomDistancePixels) pair.mode = 'zoom';
      else if (rotate && Math.abs(rotation) >= thresholds.rotationDegrees && scaleChange <= thresholds.stableSeparationRatio) pair.mode = 'rotate';
      else if (!pair.mode && tilt && parallelVertical && delta.every(point => Math.abs(point.y) >= thresholds.tiltFingerDistancePixels)
        && Math.abs(vertical) >= thresholds.tiltDistancePixels && scaleChange <= thresholds.stableSeparationRatio
        && Math.abs(rotation) <= thresholds.tiltAngleDegrees) pair.mode = 'tilt';
      else if (!pair.mode && (!tilt || !parallelVertical) && Math.hypot(middle(after).x - middle(start).x, vertical) >= thresholds.panDistancePixels
        && scaleChange <= thresholds.stableSeparationRatio && Math.abs(rotation) <= thresholds.tiltAngleDegrees) pair.mode = 'pan';
      if (!pair.mode) return null;
    }
    const previous = pair.reported; pair.reported = after;
    if (pair.mode === 'tilt') return { pan: null, zoom: null, tilt: { degrees: (middle(after).y - middle(previous).y) * thresholds.tiltDegreesPerPixel } };
    const pan = { from: middle(previous), to: middle(after) };
    if (pair.mode === 'pan') return { pan, zoom: null };
    if (pair.mode === 'rotate') {
      const degrees = angleDelta(after, pair.rotationPair); pair.rotationPair = after;
      return { pan, zoom: null, rotation: { degrees, point: middle(previous) } };
    }
    const factor = currentDistance / pair.zoomDistance; pair.zoomDistance = currentDistance;
    return { pan, zoom: { factor, point: middle(previous) } };
  }
  return {
    has(id) { return pointers.has(id); },
    pending() { return Boolean(pairGesture?.dirty); },
    flush() { return flushPair(); },
    begin(id, point, labelId = null) {
      if (!valid(point)) return false;
      pointers.set(id, { ...point });
      if (!gesture) gesture = { start: { ...point }, moved: false, multi: false, labelId };
      if (pointers.size > 1) { gesture.multi = true; gesture.moved = true; }
      pairGesture = pointers.size === 2 ? beginPair() : null;
      return true;
    },
    move(id, point) {
      if (!pointers.has(id) || !valid(point)) return null;
      const previous = pointers.get(id); const before = [...pointers.values()];
      pointers.set(id, { ...point }); const after = [...pointers.values()];
      if (pointers.size === 2) {
        gesture.multi = true; gesture.moved = true;
        if (rotate || tilt || coalesce) {
          if (!pairGesture.dirty) pairGesture.dirtyAt = now();
          pairGesture.changed.add(id); pairGesture.dirty = true;
          return coalesce ? null : flushPair(true);
        }
        const beforeDistance = distance(before);
        return { pan: { from: middle(before), to: middle(after) },
          zoom: beforeDistance > 1 ? { factor: distance(after) / beforeDistance, point: middle(before) } : null };
      }
      if (pointers.size !== 1) return null;
      if (Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > thresholds.tapMovementPixels) gesture.moved = true;
      return gesture.moved ? { pan: { from: previous, to: point }, zoom: null } : null;
    },
    end(id, point) {
      if (!pointers.has(id)) return null;
      const displaced = !valid(point) || Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) > thresholds.tapMovementPixels;
      const tap = !gesture.moved && !gesture.multi && !displaced ? { point: { ...point }, labelId: gesture.labelId } : null;
      pointers.delete(id);
      pairGesture = pointers.size === 2 ? beginPair() : null;
      if (!pointers.size) gesture = null;
      else { gesture.moved = true; gesture.start = { ...pointers.values().next().value }; }
      return tap;
    },
    cancel() { pointers.clear(); gesture = null; pairGesture = null; },
  };
}

export function polygonBorderPositions(polygon, center, width, origin = { x: 500, y: 390 }) {
  const inner = polygon.map(point => {
    const distance = Math.hypot(point.x - center.x, point.y - center.y);
    const fraction = distance ? Math.min(.35, width / distance) : 0;
    return { x: point.x + (center.x - point.x) * fraction, y: point.y + (center.y - point.y) * fraction };
  });
  const coordinates = [];
  const append = point => coordinates.push(point.x - origin.x, 0, point.y - origin.y);
  for (let index = 0; index < polygon.length; index += 1) {
    const next = (index + 1) % polygon.length;
    for (const point of [polygon[index], polygon[next], inner[index], inner[index], polygon[next], inner[next]]) append(point);
  }
  return new Float32Array(coordinates);
}
