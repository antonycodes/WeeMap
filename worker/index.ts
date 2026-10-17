type LocationMessage = {
  type: 'location';
  memberId: string;
  displayName: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speedKmh?: number;
  recordedAt: string;
};

const APP_ORIGINS = new Set(['https://weemap.antony.codes', 'https://weemap.vercel.app']);

export class TripRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  // shortcut: snapshot is in-memory for the PoC; use DO storage for durable presence later.
  private readonly latestLocations = new Map<string, LocationMessage>();

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket required' }, 426);
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    for (const location of this.latestLocations.values()) pair[1].send(JSON.stringify(location));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 4096) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (!isLocationMessage(parsed)) return;

    const member = await this.env.DB.prepare('SELECT display_name FROM trip_members WHERE trip_id = ? AND member_id = ?')
      .bind(this.ctx.id.name ?? 'unknown', parsed.memberId)
      .first<{ display_name: string }>();
    if (!member) return;
    const location = { ...parsed, displayName: member.display_name };
    this.latestLocations.set(location.memberId, location);

    await this.env.DB.prepare(
      'INSERT INTO location_events (trip_id, member_id, latitude, longitude, accuracy, speed_kmh, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      this.ctx.id.name ?? 'unknown',
      location.memberId,
      location.latitude,
      location.longitude,
      location.accuracy ?? null,
      location.speedKmh ?? null,
      location.recordedAt,
    ).run();

    const payload = JSON.stringify(location);
    for (const client of this.ctx.getWebSockets()) {
      try {
        client.send(payload);
      } catch {
        client.close(1011, 'send failed');
      }
    }
  }

  webSocketClose(socket: WebSocket): void {
    socket.close();
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'socket error');
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

    if (url.pathname === '/api/health') return json({ ok: true, phase: 0 }, 200, request);

    if (url.pathname === '/api/trips' && request.method === 'POST') {
      const body = await readJson(request);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) return json({ error: 'Trip name is required' }, 400, request);
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO trips (id, name) VALUES (?, ?)').bind(id, name).run();
      return json({ id, name, status: 'active' }, 201, request);
    }

    const tripMatch = url.pathname.match(/^\/api\/trips\/([0-9a-f-]{36})(?:\/members)?$/i);
    if (tripMatch && url.pathname === `/api/trips/${tripMatch[1]}` && request.method === 'GET') {
      const trip = await env.DB.prepare('SELECT id, name, status, created_at FROM trips WHERE id = ?').bind(tripMatch[1]).first();
      return trip ? json(trip, 200, request) : json({ error: 'Trip not found' }, 404, request);
    }

    if (tripMatch && url.pathname.endsWith('/members') && request.method === 'GET') {
      const members = await env.DB.prepare('SELECT member_id, display_name, joined_at FROM trip_members WHERE trip_id = ? ORDER BY joined_at ASC')
        .bind(tripMatch[1])
        .all();
      return json({ members: members.results }, 200, request);
    }

    if (tripMatch && url.pathname.endsWith('/members') && request.method === 'POST') {
      const body = await readJson(request);
      const memberId = typeof body?.memberId === 'string' ? body.memberId.trim().slice(0, 80) : '';
      const displayName = typeof body?.displayName === 'string' ? body.displayName.trim().slice(0, 40) : '';
      if (!memberId || !displayName) return json({ error: 'Vehicle name is required' }, 400, request);
      const trip = await env.DB.prepare('SELECT id FROM trips WHERE id = ?').bind(tripMatch[1]).first();
      if (!trip) return json({ error: 'Trip not found' }, 404, request);
      await env.DB.prepare(
        'INSERT INTO trip_members (trip_id, member_id, display_name) VALUES (?, ?, ?) ON CONFLICT(trip_id, member_id) DO UPDATE SET display_name = excluded.display_name',
      ).bind(tripMatch[1], memberId, displayName).run();
      return json({ memberId, displayName }, 201, request);
    }

    const socketMatch = url.pathname.match(/^\/ws\/([0-9a-f-]{36})$/i);
    if (socketMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const id = env.TRIP_ROOM.idFromName(socketMatch[1]);
      return env.TRIP_ROOM.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

function json(value: unknown, status = 200, request?: Request): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...corsHeaders(request), 'content-type': 'application/json; charset=utf-8' } });
}

function corsHeaders(request?: Request): HeadersInit {
  const requestOrigin = request?.headers.get('Origin') ?? '';
  return {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-origin': APP_ORIGINS.has(requestOrigin) ? requestOrigin : 'https://weemap.vercel.app',
    'vary': 'Origin',
  };
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLengthHeader = request.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isFinite(contentLength) || contentLength > 2048) return null;
  }
  if (!request.body) return null;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 2048) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk.value);
  }

  try {
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value: unknown = JSON.parse(new TextDecoder().decode(body));
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function isLocationMessage(value: unknown): value is LocationMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LocationMessage>;
  return item.type === 'location'
    && typeof item.memberId === 'string'
    && item.memberId.length <= 80
    && typeof item.displayName === 'string'
    && item.displayName.length <= 40
    && typeof item.latitude === 'number'
    && Number.isFinite(item.latitude)
    && item.latitude >= -90 && item.latitude <= 90
    && typeof item.longitude === 'number'
    && Number.isFinite(item.longitude)
    && item.longitude >= -180 && item.longitude <= 180
    && typeof item.recordedAt === 'string'
    && item.recordedAt.length <= 40
    && (item.accuracy === undefined || (typeof item.accuracy === 'number' && Number.isFinite(item.accuracy) && item.accuracy >= 0))
    && (item.speedKmh === undefined || (typeof item.speedKmh === 'number' && Number.isFinite(item.speedKmh) && item.speedKmh >= 0));
}
