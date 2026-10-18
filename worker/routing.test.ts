import { afterEach, describe, expect, it, vi } from 'vitest';
import { TripRoom } from './index';
import { calculateRouteMatrix, routesFromMatrix } from './routing';

const points = [
  { memberId: 'car-1', latitude: 10.7798, longitude: 106.698 },
  { memberId: 'car-2', latitude: 10.7769, longitude: 106.7031 },
];
const matrix = { distances: [[0, 2400], [3200, 0]], durations: [[0, 360], [480, 0]] };
afterEach(() => vi.unstubAllGlobals());

describe('routing service', () => {
  it('uses longitude before latitude and preserves directed distances', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(matrix));
    vi.stubGlobal('fetch', fetcher);
    const result = await calculateRouteMatrix('test-key', points);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ locations: [[106.698, 10.7798], [106.7031, 10.7769]], metrics: ['distance', 'duration'], units: 'm' });
    expect(routesFromMatrix(result, 'car-1', new Set(['car-1', 'car-2']))).toEqual([{ memberId: 'car-2', distanceMeters: 2400, durationSeconds: 360 }]);
    expect(routesFromMatrix(result, 'car-2', new Set(['car-1', 'car-2']))[0].distanceMeters).toBe(3200);
  });

  it('does not treat unreachable routes as zero distance', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ distances: [[0, null], [null, 0]], durations: [[0, null], [null, 0]] })));
    const result = await calculateRouteMatrix('test-key', points);
    expect(routesFromMatrix(result, 'car-1', new Set(['car-1', 'car-2']))).toEqual([]);
  });

  it('rejects malformed matrix dimensions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ distances: [[0]], durations: [[0]] })));
    await expect(calculateRouteMatrix('test-key', points)).rejects.toThrow('Invalid routing response');
  });
});

function roomFixture() {
  const records = points.map((point) => ({ member_id: point.memberId, display_name: point.memberId, latitude: point.latitude, longitude: point.longitude, accuracy: null, speed_kmh: null, recorded_at: new Date().toISOString() }));
  const stored = new Map<string, unknown>();
  const ctx = {
    id: { name: 'TEST' },
    storage: { get: async (key: string) => stored.get(key), put: async (key: string, value: unknown) => { stored.set(key, value); } },
  } as unknown as ConstructorParameters<typeof TripRoom>[0];
  const env = {
    ORS_API_KEY: 'test-key',
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ member_token: 'valid-token' }), all: async () => ({ results: records }) }) }) },
  } as unknown as ConstructorParameters<typeof TripRoom>[1];
  const request = (token = 'valid-token') => new Request('https://example.com/api/trips/TEST/routes', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ memberId: 'car-1', memberToken: token }) });
  return { room: new TripRoom(ctx, env), ctx, env, records, request };
}

describe('trip routing authorization and shared cache', () => {
  it('returns short-lived TURN credentials without exposing the Worker secret', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      iceServers: [{ urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:53'], username: 'user', credential: 'credential' }],
    }, { status: 201 }));
    vi.stubGlobal('fetch', fetcher);
    const { room, env } = roomFixture();
    Object.assign(env, { TURN_KEY_TOKEN: 'turn-token-id', TURN_KEY_SECRET: 'turn-secret' });
    const response = await room.fetch(new Request('https://example.com/api/trips/TEST/voice-credentials', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ memberId: 'car-1', memberToken: 'valid-token' }),
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'], username: 'user', credential: 'credential' }] });
    expect(fetcher.mock.calls[0][0]).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/turn-token-id/credentials/generate-ice-servers');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer turn-secret');
  });

  it('rejects expired sessions before using the routing quota', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { room, request } = roomFixture();
    expect((await room.fetch(request('expired'))).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('requires fresh source GPS before calculating a route', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { room, records, request } = roomFixture();
    records[0].recorded_at = new Date(Date.now() - 120_000).toISOString();
    expect((await room.fetch(request())).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('shares one provider call across simultaneous requests and object restarts', async () => {
    const fetcher = vi.fn().mockImplementation(async () => Response.json(matrix));
    vi.stubGlobal('fetch', fetcher);
    const { room, ctx, env, request } = roomFixture();
    const responses = await Promise.all([room.fetch(request()), room.fetch(request())]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(fetcher).toHaveBeenCalledOnce();
    const restored = new TripRoom(ctx, env);
    expect((await restored.fetch(request())).status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not include a target whose GPS became stale', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(matrix)));
    const { room, records, request } = roomFixture();
    await room.fetch(request());
    records[1].recorded_at = new Date(Date.now() - 120_000).toISOString();
    const response = await room.fetch(request());
    expect((await response.json() as { routes: unknown[] }).routes).toEqual([]);
  });

  it('waits before retrying after a provider quota error', async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response('', { status: 429 }));
    vi.stubGlobal('fetch', fetcher);
    const { room, request } = roomFixture();
    expect((await room.fetch(request())).status).toBe(503);
    expect((await room.fetch(request())).status).toBe(503);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
