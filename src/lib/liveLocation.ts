export type LiveLocation = {
  memberId: string;
  displayName?: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speedKmh?: number;
  recordedAt: string;
};

export function parseLiveLocation(value: unknown): LiveLocation | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Partial<LiveLocation> & { type?: unknown };
  if (
    item.type !== 'location'
    || typeof item.memberId !== 'string'
    || item.memberId.length > 80
    || (item.displayName !== undefined && (typeof item.displayName !== 'string' || item.displayName.length > 40))
    || typeof item.latitude !== 'number'
    || !Number.isFinite(item.latitude)
    || item.latitude < -90
    || item.latitude > 90
    || typeof item.longitude !== 'number'
    || !Number.isFinite(item.longitude)
    || item.longitude < -180
    || item.longitude > 180
    || typeof item.recordedAt !== 'string'
    || item.recordedAt.length > 40
  ) return null;

  if (item.accuracy !== undefined && (typeof item.accuracy !== 'number' || !Number.isFinite(item.accuracy) || item.accuracy < 0)) return null;
  if (item.speedKmh !== undefined && (typeof item.speedKmh !== 'number' || !Number.isFinite(item.speedKmh) || item.speedKmh < 0)) return null;

  return {
    memberId: item.memberId,
    displayName: item.displayName,
    latitude: item.latitude,
    longitude: item.longitude,
    accuracy: item.accuracy,
    speedKmh: item.speedKmh,
    recordedAt: item.recordedAt,
  };
}
