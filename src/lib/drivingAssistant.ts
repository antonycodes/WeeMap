export function speedFromMetersPerSecond(speed: number | null): number | null {
  if (speed === null || !Number.isFinite(speed) || speed < 0) return null;
  return Math.round(speed * 3.6);
}
