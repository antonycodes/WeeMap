import { distanceBetweenKm } from './liveLocation';

export type Coordinates = [number, number];
export type PlannedRoute = { coordinates: Coordinates[]; distanceMeters: number; durationSeconds: number };
export type RouteProgress = {
  traveled: Coordinates[];
  remaining: Coordinates[];
  remainingDistanceMeters: number;
  offRoute: boolean;
};

export function isCoordinates(value: unknown): value is Coordinates {
  return Array.isArray(value) && value.length === 2 && value.every((number) => typeof number === 'number' && Number.isFinite(number))
    && Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
}

export function parsePlannedRoute(value: unknown): PlannedRoute | null {
  if (!value || typeof value !== 'object') return null;
  const route = value as Partial<PlannedRoute>;
  if (!Array.isArray(route.coordinates) || route.coordinates.length < 2 || route.coordinates.length > 100_000 || !route.coordinates.every(isCoordinates)
    || typeof route.distanceMeters !== 'number' || !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0
    || typeof route.durationSeconds !== 'number' || !Number.isFinite(route.durationSeconds) || route.durationSeconds < 0) return null;
  return route as PlannedRoute;
}

export function getRouteProgress(route: PlannedRoute, position: Coordinates, offRouteThresholdMeters = 150): RouteProgress {
  const current = { latitude: position[1], longitude: position[0] };
  let nearestIndex = 0;
  let nearestDistanceMeters = Number.POSITIVE_INFINITY;

  // shortcut: nearest route vertex; use segment projection if simplified routes trigger false reroutes.
  route.coordinates.forEach((coordinate, index) => {
    const distanceMeters = distanceBetweenKm(current, { latitude: coordinate[1], longitude: coordinate[0] }) * 1000;
    if (distanceMeters < nearestDistanceMeters) {
      nearestIndex = index;
      nearestDistanceMeters = distanceMeters;
    }
  });

  const remaining = route.coordinates.slice(nearestIndex);
  const remainingDistanceMeters = remaining.slice(1).reduce(
    (total, coordinate, index) => total + distanceBetweenKm(
      { latitude: remaining[index][1], longitude: remaining[index][0] },
      { latitude: coordinate[1], longitude: coordinate[0] },
    ) * 1000,
    0,
  );

  return {
    traveled: route.coordinates.slice(0, nearestIndex + 1),
    remaining,
    remainingDistanceMeters,
    offRoute: nearestDistanceMeters > offRouteThresholdMeters,
  };
}
