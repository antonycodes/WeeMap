import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculateDirections } from './directions';

afterEach(() => vi.unstubAllGlobals());

describe('directions service', () => {
  it('requests simplified geometry while keeping the route line', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      features: [{
        geometry: { type: 'LineString', coordinates: [[106.6, 10.7], [106.7, 10.8]] },
        properties: { summary: { distance: 1000, duration: 60 } },
      }],
    }));
    vi.stubGlobal('fetch', fetcher);

    const route = await calculateDirections('test-key', [106.6, 10.7], [106.7, 10.8]);
    const body = JSON.parse(fetcher.mock.calls[0][1].body);

    expect(body).toMatchObject({ instructions: false, geometry_simplify: true });
    expect(route.coordinates).toHaveLength(2);
  });
});
