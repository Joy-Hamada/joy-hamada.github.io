const limit = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));

export function screenToWorld(view, point) {
  return { x: (point.x - view.x) / view.scale, y: (point.y - view.y) / view.scale };
}

export function projectRectangle(view, rectangle) {
  return { x: rectangle.x * view.scale + view.x, y: rectangle.y * view.scale + view.y, width: rectangle.width * view.scale, height: rectangle.height * view.scale };
}

export function fitRectangle(rectangle, size, { padding = 44, minimum = .000001, maximum = 1000000 } = {}) {
  const usableWidth = Math.max(1, size.width - Math.min(padding * 2, size.width * .3));
  const usableHeight = Math.max(1, size.height - Math.min(padding * 2, size.height * .3));
  const scale = limit(Math.min(usableWidth / Math.max(rectangle.width, .000001), usableHeight / Math.max(rectangle.height, .000001)), minimum, maximum);
  return { scale, x: size.width / 2 - (rectangle.x + rectangle.width / 2) * scale, y: size.height / 2 - (rectangle.y + rectangle.height / 2) * scale };
}

export function zoomAt(view, factor, point, { minimum = .000001, maximum = 1000000 } = {}) {
  if (!Number.isFinite(factor) || factor <= 0) return { ...view };
  const world = screenToWorld(view, point);
  const scale = limit(view.scale * factor, minimum, maximum);
  return { scale, x: point.x - world.x * scale, y: point.y - world.y * scale };
}

function midpoint(first, second) { return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 }; }

export function pinchViewport(view, previousPair, nextPair, limits) {
  const previousDistance = Math.hypot(previousPair[0].x - previousPair[1].x, previousPair[0].y - previousPair[1].y);
  const nextDistance = Math.hypot(nextPair[0].x - nextPair[1].x, nextPair[0].y - nextPair[1].y);
  const previousCenter = midpoint(...previousPair);
  const nextCenter = midpoint(...nextPair);
  const changed = zoomAt(view, previousDistance > 1 ? Math.max(1, nextDistance) / previousDistance : 1, previousCenter, limits);
  return { ...changed, x: changed.x + nextCenter.x - previousCenter.x, y: changed.y + nextCenter.y - previousCenter.y };
}

export function interpolateViewport(from, to, progress, size) {
  const fraction = limit(progress, 0, 1);
  const center = { x: size.width / 2, y: size.height / 2 };
  const origin = screenToWorld(from, center); const destination = screenToWorld(to, center);
  const scale = Math.exp(Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * fraction);
  const world = { x: origin.x + (destination.x - origin.x) * fraction, y: origin.y + (destination.y - origin.y) * fraction };
  return { scale, x: center.x - world.x * scale, y: center.y - world.y * scale };
}

export function constrainViewport(view, bounds, size, margin = 64) {
  const constrainAxis = (offset, start, length, viewport) => {
    const visibleMargin = Math.min(margin, viewport * .2);
    const extent = length * view.scale;
    if (extent <= viewport - 2 * visibleMargin) return (viewport - extent) / 2 - start * view.scale;
    return limit(offset, visibleMargin - (start + length) * view.scale, viewport - visibleMargin - start * view.scale);
  };
  return { ...view, x: constrainAxis(view.x, bounds.x, bounds.width, size.width), y: constrainAxis(view.y, bounds.y, bounds.height, size.height) };
}

export function intersectsViewport(rectangle, size) {
  return rectangle.x < size.width && rectangle.y < size.height && rectangle.x + rectangle.width > 0 && rectangle.y + rectangle.height > 0;
}

export function selectStudyRoots(model, studyId = null) {
  return studyId === null ? [...model.roots] : model.roots.filter(id => model.nodes.get(id)?.studyId === studyId);
}

export function belongsToStudy(node, studyId = null) {
  return Boolean(node && (studyId === null || node.studyId === studyId));
}

export function shouldAggregate(node, rectangle) {
  return node.kind !== 'file' && node.childIds.length > 1 && (Math.min(rectangle.width, rectangle.height) < 48 || rectangle.width * rectangle.height < 9000);
}

export function createPointerGesture() {
  const pointers = new Map();
  return {
    activeIds: () => [...pointers.keys()],
    begin(id, point) {
      if (pointers.size >= 2 || pointers.has(id)) return false;
      pointers.set(id, { point, origin: point, moved: false });
      if (pointers.size === 2) for (const entry of pointers.values()) entry.moved = true;
      return true;
    },
    move(id, point) {
      const entry = pointers.get(id);
      if (!entry) return null;
      const previousPair = [...pointers.values()].map(pointer => pointer.point);
      const previous = entry.point;
      entry.point = point;
      if (Math.hypot(point.x - entry.origin.x, point.y - entry.origin.y) > 5) entry.moved = true;
      return pointers.size === 2
        ? { kind: 'pinch', previousPair, nextPair: [...pointers.values()].map(pointer => pointer.point) }
        : { kind: 'pan', dx: point.x - previous.x, dy: point.y - previous.y };
    },
    end(id) {
      const entry = pointers.get(id);
      if (!entry) return { select: false };
      const select = pointers.size === 1 && !entry.moved;
      pointers.delete(id);
      return { select };
    },
    cancel() { pointers.clear(); },
  };
}

export function groupFlowMarkers(nodeIds, activeIndex) {
  const groups = new Map();
  nodeIds.forEach((id, index) => {
    if (!groups.has(id)) groups.set(id, { id, steps: [], activeStep: null });
    const group = groups.get(id);
    group.steps.push(index + 1);
    if (index === activeIndex) group.activeStep = index + 1;
  });
  return [...groups.values()].sort((first, second) => Number(first.activeStep !== null) - Number(second.activeStep !== null));
}

export function flowSegmentHasLength(points, index) {
  const from = points[index]; const to = points[index + 1];
  return Boolean(from && to && Math.hypot(to.x - from.x, to.y - from.y) > .5);
}
