import { describe, expect, it } from 'vitest';
import { extractTripCode, isValidTripCode, normalizeTripCode } from './tripCode';

describe('trip codes', () => {
  it('normalizes custom codes and accepts shared links', () => {
    expect(normalizeTripCode('  road_01 ')).toBe('ROAD_01');
    expect(extractTripCode('https://weemap.antony.codes/?trip=road_01')).toBe('ROAD_01');
    expect(isValidTripCode('ROAD_01')).toBe(true);
  });

  it('rejects codes outside the supported format', () => {
    expect(isValidTripCode('ABC')).toBe(false);
    expect(isValidTripCode('A B C D')).toBe(false);
  });
});
