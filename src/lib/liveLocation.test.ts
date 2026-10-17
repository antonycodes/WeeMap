import { describe, expect, it } from 'vitest';
import { distanceBetweenKm, parseLiveLocation } from './liveLocation';

describe('parseLiveLocation', () => {
  it('accepts a valid location and rejects invalid coordinates', () => {
    expect(parseLiveLocation({ type: 'location', memberId: 'car-1', displayName: 'Xe A', latitude: 10.7, longitude: 106.6, recordedAt: new Date().toISOString() })?.displayName).toBe('Xe A');
    expect(parseLiveLocation({ type: 'location', memberId: 'car-1', latitude: 120, longitude: 106.6, recordedAt: new Date().toISOString() })).toBeNull();
  });

  it('calculates distance between two GPS points', () => {
    expect(distanceBetweenKm({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(111.2, 0);
  });
});
