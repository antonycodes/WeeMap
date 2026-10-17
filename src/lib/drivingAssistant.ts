export const DEFAULT_SPEED_LIMIT = 60;

export function speedFromMetersPerSecond(speed: number | null): number | null {
  if (speed === null || !Number.isFinite(speed) || speed < 0) return null;
  return Math.round(speed * 3.6);
}

export function isOverSpeedLimit(speed: number | null, limit: number): boolean {
  return speed !== null && Number.isFinite(speed) && speed > limit;
}
