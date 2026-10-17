export type RouteEstimate = { memberId: string; distanceMeters: number; durationSeconds: number };
export type RouteEstimates = { calculatedAt: number; routes: RouteEstimate[] };

export function parseRouteEstimates(value: unknown): RouteEstimates | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Partial<RouteEstimates>;
  if (typeof data.calculatedAt !== 'number' || !Number.isFinite(data.calculatedAt) || !Array.isArray(data.routes)) return null;
  if (data.routes.some((route) => !route || typeof route.memberId !== 'string'
    || typeof route.distanceMeters !== 'number' || !Number.isFinite(route.distanceMeters) || route.distanceMeters < 0
    || typeof route.durationSeconds !== 'number' || !Number.isFinite(route.durationSeconds) || route.durationSeconds < 0)) return null;
  return { calculatedAt: data.calculatedAt, routes: data.routes };
}

export function formatRouteEstimate(route: RouteEstimate): string {
  const distance = route.distanceMeters < 1000
    ? `${Math.round(route.distanceMeters)} m`
    : `${(route.distanceMeters / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} km`;
  return `${distance} đường đi · khoảng ${Math.max(1, Math.ceil(route.durationSeconds / 60))} phút`;
}
