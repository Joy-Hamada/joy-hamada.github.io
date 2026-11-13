import { buildRevisionLibrary, libraryLayoutPolicy } from './library-model.mjs';

const fullTurn = Math.PI * 2;
const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOr = (value, fallback) => Number.isFinite(value) ? value : fallback;
const wrapYaw = yaw => ((yaw + Math.PI) % fullTurn + fullTurn) % fullTurn - Math.PI;

export const libraryOrbitPolicy = 'revision-library-orbit-v1';
export const libraryOrbitLimits = Object.freeze({
  minimumPitch: 20 * Math.PI / 180,
  maximumPitch: 72 * Math.PI / 180,
  defaultPitch: 38 * Math.PI / 180,
  defaultYaw: Math.PI / 5,
  fieldOfView: 42,
});

export function buildLibraryOrbitModel(frameOrLibrary) {
  const library = frameOrLibrary?.policy === libraryLayoutPolicy ? frameOrLibrary : buildRevisionLibrary(frameOrLibrary);
  const shelves = library.sectors.flatMap(sector => sector.rows.map(row => ({
    ...row, id: `${sector.path}:${row.row}`, sector: sector.path, baseY: 6, height: 38,
  })));
  const books = library.books.map(node => {
    const arc = node.book;
    const angle = (arc.startAngle + arc.endAngle) / 2;
    const radius = (arc.innerRadius + arc.outerRadius) / 2;
    const height = 24 + Math.min(10, Math.log2(node.bytes + 1) * .6);
    return {
      id: node.id, node,
      position: { x: Math.cos(angle) * radius, y: 10 + height / 2, z: Math.sin(angle) * radius },
      size: {
        width: Math.max(.3, 2 * radius * Math.sin((arc.endAngle - arc.startAngle) / 2) * .88),
        height, depth: arc.outerRadius - arc.innerRadius,
      },
      yaw: Math.PI / 2 - angle,
    };
  });
  const height = Math.min(360, 92 + 16 * Math.log2(library.root.fileCount + 1));
  const levels = Math.min(9, 3 + Math.floor(Math.log2(library.root.fileCount + 1) / 2));
  const tierHeight = (height - 42) / levels;
  const tower = {
    height, levels, radius: 78, fileCount: library.root.fileCount,
    ornaments: library.tower.ornaments, kinds: [...library.tower.kinds],
    tiers: Array.from({ length: levels }, (_, index) => ({
      y: 12 + index * tierHeight, height: tierHeight,
      bottomRadius: 62 - index * 5, topRadius: 55 - index * 5,
    })),
  };
  return {
    policy: libraryOrbitPolicy, revision: library.revision, library, books, shelves, tower,
    radius: library.outerRadius, target: { x: 0, y: height * .32, z: 0 },
  };
}

export function libraryOrbitConstraints(world, { aspect = 1 } = {}) {
  const safeAspect = clamp(finiteOr(aspect, 1), .25, 4);
  const verticalHalfAngle = libraryOrbitLimits.fieldOfView * Math.PI / 360;
  const limitingHalfAngle = Math.min(verticalHalfAngle, Math.atan(Math.tan(verticalHalfAngle) * safeAspect));
  const enclosingRadius = Math.hypot(world.radius + 18, Math.max(world.target.y, world.tower.height - world.target.y));
  const minimumDistance = Math.max(150, world.radius * .8, world.tower.height * 1.05);
  const fitDistance = Math.max(minimumDistance, enclosingRadius / Math.sin(limitingHalfAngle) * 1.04);
  return {
    minimumPitch: libraryOrbitLimits.minimumPitch, maximumPitch: libraryOrbitLimits.maximumPitch,
    minimumDistance, maximumDistance: Math.max(fitDistance * 2.8, minimumDistance * 2), fitDistance,
  };
}

export function createLibraryOrbitState(world, options = {}) {
  return {
    yaw: libraryOrbitLimits.defaultYaw, pitch: libraryOrbitLimits.defaultPitch,
    distance: libraryOrbitConstraints(world, options).fitDistance,
  };
}

export function normalizeLibraryOrbit(state, world) {
  // A larger portrait fit must remain valid when subsequent gestures lack an aspect argument.
  const limits = libraryOrbitConstraints(world, { aspect: .25 });
  return {
    yaw: wrapYaw(finiteOr(state?.yaw, libraryOrbitLimits.defaultYaw)),
    pitch: clamp(finiteOr(state?.pitch, libraryOrbitLimits.defaultPitch), limits.minimumPitch, limits.maximumPitch),
    distance: clamp(finiteOr(state?.distance, createLibraryOrbitState(world).distance), limits.minimumDistance, limits.maximumDistance),
  };
}

export function rotateLibraryOrbit(state, movement, world) {
  const normalized = normalizeLibraryOrbit(state, world);
  return normalizeLibraryOrbit({
    ...normalized,
    yaw: normalized.yaw + finiteOr(movement?.yaw, 0),
    pitch: normalized.pitch + finiteOr(movement?.pitch, 0),
  }, world);
}

export function zoomLibraryOrbit(state, factor, world) {
  const normalized = normalizeLibraryOrbit(state, world);
  if (!Number.isFinite(factor) || factor <= 0) return normalized;
  return normalizeLibraryOrbit({ ...normalized, distance: normalized.distance / clamp(factor, .01, 100) }, world);
}

export function orbitCameraPosition(state, world) {
  const orbit = normalizeLibraryOrbit(state, world);
  const horizontalDistance = Math.cos(orbit.pitch) * orbit.distance;
  return {
    x: Math.sin(orbit.yaw) * horizontalDistance,
    y: world.target.y + Math.sin(orbit.pitch) * orbit.distance,
    z: Math.cos(orbit.yaw) * horizontalDistance,
  };
}

export function focusLibraryOrbit(state, world, id) {
  const node = world.library.nodes.get(id);
  if (!node) return normalizeLibraryOrbit(state, world);
  if (!id) return createLibraryOrbitState(world);
  const limits = libraryOrbitConstraints(world);
  return normalizeLibraryOrbit({
    ...state,
    yaw: Math.PI / 2 - Math.atan2(node.center.y, node.center.x),
    distance: Math.max(limits.minimumDistance, limits.fitDistance * (node.type === 'file' ? .42 : .7)),
  }, world);
}
