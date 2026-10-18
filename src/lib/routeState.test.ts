import { describe, expect, it } from 'vitest';
import { parseSharedRouteState } from './routeState';

describe('shared route state', () => {
  it('accepts a valid started route', () => {
    expect(parseSharedRouteState({ started: true, target: { code: '8PXXXXX+', latitude: 10.7, longitude: 106.6, shortened: false } })).toEqual({
      started: true,
      target: { code: '8PXXXXX+', latitude: 10.7, longitude: 106.6, shortened: false },
    });
  });

  it('rejects invalid target coordinates', () => {
    expect(parseSharedRouteState({ started: true, target: { code: 'bad', latitude: 91, longitude: 106.6, shortened: false } })).toBeNull();
  });
});
