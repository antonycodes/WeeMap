export type Coordinates = [number, number];
export type PlannedRoute = { coordinates: Coordinates[]; distanceMeters: number; durationSeconds: number };
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
