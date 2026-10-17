import { describe, expect, it } from 'vitest';
import { formatRouteEstimate, parseRouteEstimates } from './routeEstimate';

describe('route estimate display', () => {
  it('formats road distance and duration in Vietnamese', () => {
    expect(formatRouteEstimate({ memberId: 'car-2', distanceMeters: 2400, durationSeconds: 360 })).toBe('2,4 km đường đi · khoảng 6 phút');
  });
  it('rounds a short route up to one minute', () => {
    expect(formatRouteEstimate({ memberId: 'car-2', distanceMeters: 150, durationSeconds: 15 })).toBe('150 m đường đi · khoảng 1 phút');
  });
  it('rejects invalid provider-derived values', () => {
    expect(parseRouteEstimates({ calculatedAt: Date.now(), routes: [{ memberId: 'car-2', distanceMeters: -10, durationSeconds: 60 }] })).toBeNull();
    expect(parseRouteEstimates({ calculatedAt: Date.now(), routes: [{ memberId: 'car-2', distanceMeters: 10, durationSeconds: NaN }] })).toBeNull();
  });
});
