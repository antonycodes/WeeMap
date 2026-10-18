import { afterEach, describe, expect, it, vi } from 'vitest';
import { geocodeDestination } from './geocode';

afterEach(() => vi.unstubAllGlobals());

describe('destination geocoder', () => {
  it('returns the first point from openrouteservice', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      features: [{ geometry: { type: 'Point', coordinates: [106.6, 10.7] }, properties: { label: 'Test address' } }],
    }), { status: 200 })));

    await expect(geocodeDestination('test-key', 'Test address')).resolves.toEqual({
      code: 'Test address', label: 'Test address', latitude: 10.7, longitude: 106.6, shortened: false,
    });
  });
});
