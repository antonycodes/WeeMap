type LocationMessage = {
  type: 'location';
  memberId: string;
  latitude: number;
  longitude: number;
  accuracy?: number;
  speedKmh?: number;
  recordedAt: string;
};

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

    this.latestLocations.set(parsed.memberId, parsed);

    await this.env.DB.prepare(
      'INSERT INTO location_events (trip_id, member_id, latitude, longitude, accuracy, speed_kmh, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).bind(
      this.ctx.id.name ?? 'unknown',
      parsed.memberId,
      parsed.latitude,
      parsed.longitude,
      parsed.accuracy ?? null,
      parsed.speedKmh ?? null,
      parsed.recordedAt,
    ).run();

    const payload = JSON.stringify(parsed);
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

    if (url.pathname === '/api/health') return json({ ok: true, phase: 0 });

    if (url.pathname === '/api/trips' && request.method === 'POST') {
      const body = await readJson(request);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) return json({ error: 'Trip name is required' }, 400);
      const id = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO trips (id, name) VALUES (?, ?)').bind(id, name).run();
      return json({ id, name, status: 'active' }, 201);
    }

    const tripMatch = url.pathname.match(/^\/api\/trips\/([0-9a-f-]{36})$/i);
    if (tripMatch && request.method === 'GET') {
      const trip = await env.DB.prepare('SELECT id, name, status, created_at FROM trips WHERE id = ?').bind(tripMatch[1]).first();
      return trip ? json(trip) : json({ error: 'Trip not found' }, 404);
    }

    const socketMatch = url.pathname.match(/^\/ws\/([0-9a-f-]{36})$/i);
    if (socketMatch && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      const id = env.TRIP_ROOM.idFromName(socketMatch[1]);
      return env.TRIP_ROOM.get(id).fetch(request);
    }

    return json({ error: 'Not found' }, 404);
  },
} satisfies ExportedHandler<Env>;

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
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
