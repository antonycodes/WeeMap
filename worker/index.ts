import { calculateDirections, DirectionsError } from './directions';
import { isCoordinates } from '../src/lib/plannedRoute';
import { googleIdentity } from './googleAuth';
import { calculateRouteMatrix, routesFromMatrix, type RouteMatrix } from './routing';
import { isLiveLocationStale } from '../src/lib/liveLocation';
import { parseSharedRouteState, type SharedRouteState } from '../src/lib/routeState';
import { geocodeDestination, GeocodeError } from './geocode';

interface RoutingEnv extends Env { ORS_API_KEY?: string; TURN_KEY_TOKEN?: string; TURN_KEY_SECRET?: string }
type RoutingQuota = { day: string; total: number; clients: Record<string, { count: number; last: number }> };

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

type VoiceJoinMessage = { type: 'voice-join'; memberId: string; memberToken: string };
type VoiceSignalMessage = { type: 'voice-signal'; memberId: string; memberToken: string; targetId: string; signal: Record<string, unknown> };
type VoiceStateMessage = { type: 'voice-state'; memberId: string; memberToken: string; speaking: boolean };
type VoiceCallMessage = { type: 'voice-call'; memberId: string; memberToken: string; active: boolean };
type VoiceAttachment = { memberId: string };

async function hashLeaderPassword(password: string, salt: Uint8Array<ArrayBuffer>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  return [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newMemberToken(): string {
  return hex(crypto.getRandomValues(new Uint8Array(32)));
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

const APP_ORIGINS = new Set(['https://weemap.antony.codes', 'https://weemap.vercel.app', 'https://group-navigation-local.eventnpi2026.workers.dev', 'http://localhost:5173']);

export class TripRoom implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: RoutingEnv;
  private pendingRoutes?: Promise<RouteMatrix>;
  private readonly activeVoiceCalls = new Set<string>();
  private readonly voiceCallSockets = new Map<string, WebSocket>();

  constructor(ctx: DurableObjectState, env: RoutingEnv) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (request.method === 'POST' && pathname === '/api/directions') return this.directions(request);
    if (request.method === 'POST' && pathname === '/api/geocode') return this.geocode(request);
    if (request.method === 'POST' && pathname.endsWith('/route-state')) return this.routeState(request);
    if (request.method === 'POST' && pathname.endsWith('/routes')) return this.routeEstimates(request);
    if (request.method === 'POST' && pathname.endsWith('/voice-credentials')) return this.voiceCredentials(request);
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return json({ error: 'WebSocket required' }, 426);
    }

    const locations = await loadTripLocations(this.env, this.ctx.id.name ?? 'unknown');
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    for (const location of locations) pair[1].send(JSON.stringify(location));
    const routeState = await this.ctx.storage.get<SharedRouteState>('routeState');
    if (routeState) pair[1].send(JSON.stringify({ type: 'route-state', ...routeState }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private async routeState(request: Request): Promise<Response> {
    const body = await readJson(request);
    const routeState = parseSharedRouteState({ started: true, target: body?.target });
    if (!routeState) return json({ error: 'Điểm đến không hợp lệ.' }, 400, request);
    const tripId = this.ctx.id.name ?? 'unknown';
    const owner = await this.env.DB.prepare('SELECT leader_google_sub, leader_password_salt, leader_password_hash FROM trips WHERE id = ?')
      .bind(tripId)
      .first<{ leader_google_sub: string | null; leader_password_salt: string | null; leader_password_hash: string | null }>();
    if (!owner) return json({ error: 'Trip not found' }, 404, request);
    if (owner.leader_google_sub) {
      const identity = await googleIdentity(request);
      if (identity?.sub !== owner.leader_google_sub) return json({ error: 'Chỉ trưởng đoàn mới được bắt đầu lộ trình.' }, 403, request);
    } else {
      const password = typeof body?.leaderPassword === 'string' ? body.leaderPassword : '';
      if (!owner.leader_password_salt || !owner.leader_password_hash) return json({ error: 'Leader password is not configured for this trip' }, 409, request);
      const salt = Uint8Array.from(owner.leader_password_salt.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
      if (!equalHash(await hashLeaderPassword(password, salt), owner.leader_password_hash)) return json({ error: 'Chỉ trưởng đoàn mới được bắt đầu lộ trình.' }, 403, request);
    }
    await this.ctx.storage.put('routeState', routeState);
    const payload = JSON.stringify({ type: 'route-state', ...routeState });
    for (const client of this.ctx.getWebSockets()) {
      try {
        client.send(payload);
      } catch {
        client.close(1011, 'send failed');
      }
    }
    return json({ ok: true }, 200, request);
  }

  private async geocode(request: Request): Promise<Response> {
    if (!this.env.ORS_API_KEY) return json({ error: 'Chưa cấu hình dịch vụ tìm địa chỉ.' }, 503, request);
    const body = await readJson(request);
    const text = typeof body?.text === 'string' ? body.text.trim().slice(0, 160) : '';
    const shortCode = typeof body?.shortCode === 'string' ? body.shortCode.trim().slice(0, 20) : undefined;
    if (!text) return json({ error: 'Địa chỉ điểm đến không được để trống.' }, 400, request);
    if (!await this.takeRoutingQuota(request)) return json({ error: 'Đã giới hạn lượt tìm địa chỉ. Thử lại sau.' }, 429, request);
    try {
      return json(await geocodeDestination(this.env.ORS_API_KEY, text, shortCode), 200, request);
    } catch (error) {
      if (error instanceof GeocodeError) return json({ error: error.message }, error.status, request);
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return json({ error: 'Dịch vụ tìm địa chỉ phản hồi chậm. Hãy thử lại sau.' }, 504, request);
      return json({ error: 'Worker chưa kết nối được dịch vụ tìm địa chỉ.' }, 503, request);
    }
  }

  private async takeRoutingQuota(request: Request): Promise<boolean> {
    const ipHash = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(request.headers.get('CF-Connecting-IP') ?? 'local'))));
    return this.ctx.storage.transaction(async (storage) => {
      const now = Date.now();
      const day = new Date(now).toISOString().slice(0, 10);
      let quota = await storage.get<RoutingQuota>('directionsQuota');
      if (!quota || quota.day !== day) quota = { day, total: 0, clients: {} };
      const client = quota.clients[ipHash] ?? { count: 0, last: 0 };
      if (quota.total >= 600 || client.count >= 60 || now - client.last < 10_000) return false;
      quota.total++;
      quota.clients[ipHash] = { count: client.count + 1, last: now };
      await storage.put('directionsQuota', quota);
      return true;
    });
  }

  private async directions(request: Request): Promise<Response> {
    const body = await readJson(request);
    if (!isCoordinates(body?.start) || !isCoordinates(body?.end)) return json({ error: 'Tọa độ không hợp lệ.' }, 400, request);
    if (!this.env.ORS_API_KEY) return json({ error: 'Chưa cấu hình dịch vụ lộ trình.' }, 503, request);
    if (!await this.takeRoutingQuota(request)) return json({ error: 'Đã giới hạn lượt tính đường. Thử lại sau.' }, 429, request);
    try {
      return json(await calculateDirections(this.env.ORS_API_KEY, body.start, body.end), 200, request);
    } catch (error) {
      if (error instanceof DirectionsError) return json({ error: error.message }, error.status, request);
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return json({ error: 'Dịch vụ tính đường phản hồi chậm. Hãy thử lại sau.' }, 504, request);
      return json({ error: 'Worker chưa kết nối được dịch vụ tính đường. Hãy thử lại sau.' }, 503, request);
    }
  }

  private async routeEstimates(request: Request): Promise<Response> {
    const body = await readJson(request);
    const memberId = typeof body?.memberId === 'string' ? body.memberId : '';
    const memberToken = typeof body?.memberToken === 'string' ? body.memberToken : '';
    if (!memberId || memberId.length > 80 || !memberToken || memberToken.length > 128) return json({ error: 'Member authorization required' }, 403, request);
    const tripId = this.ctx.id.name ?? 'unknown';
    const member = await this.env.DB.prepare('SELECT member_token FROM trip_members WHERE trip_id = ? AND member_id = ?')
      .bind(tripId, memberId).first<{ member_token: string | null }>();
    if (!member?.member_token || !equalHash(member.member_token, memberToken)) return json({ error: 'Member authorization required' }, 403, request);
    const apiKey = this.env.ORS_API_KEY;
    if (!apiKey) return json({ error: 'Routing is not configured' }, 503, request);
    const locations = (await loadTripLocations(this.env, tripId)).filter((location) => !isLiveLocationStale(location.recordedAt));
    if (!locations.some((location) => location.memberId === memberId)) return json({ error: 'Fresh GPS required' }, 409, request);
    if (locations.length < 2) return json({ calculatedAt: Date.now(), routes: [] }, 200, request);
    if (locations.length > MAX_VEHICLES) return json({ error: 'Too many vehicles' }, 400, request);
    try {
      let matrix = await this.ctx.storage.get<RouteMatrix>('routeMatrix');
      if (!matrix || Date.now() - matrix.calculatedAt >= 60_000) {
        if (!this.pendingRoutes) {
          this.pendingRoutes = (async () => {
            const lastAttempt = await this.ctx.storage.get<number>('routeAttemptAt');
            if (lastAttempt !== undefined && Date.now() - lastAttempt < 60_000) throw new Error('Routing retry cooldown');
            await this.ctx.storage.put('routeAttemptAt', Date.now());
            const result = await calculateRouteMatrix(apiKey, locations);
            await this.ctx.storage.put('routeMatrix', result);
            return result;
          })().finally(() => { this.pendingRoutes = undefined; });
        }
        matrix = await this.pendingRoutes;
      }
      return json({ calculatedAt: matrix.calculatedAt, routes: routesFromMatrix(matrix, memberId, new Set(locations.map((location) => location.memberId))) }, 200, request);
    } catch {
      return json({ error: 'Routing temporarily unavailable' }, 503, request);
    }
  }

  private async voiceCredentials(request: Request): Promise<Response> {
    const body = await readJson(request);
    const memberId = typeof body?.memberId === 'string' ? body.memberId : '';
    const memberToken = typeof body?.memberToken === 'string' ? body.memberToken : '';
    if (!memberId || memberId.length > 80 || !memberToken || memberToken.length > 128) return json({ error: 'Member authorization required' }, 403, request);
    const member = await this.env.DB.prepare('SELECT member_token FROM trip_members WHERE trip_id = ? AND member_id = ?')
      .bind(this.ctx.id.name ?? 'unknown', memberId)
      .first<{ member_token: string | null }>();
    if (!member?.member_token || !equalHash(member.member_token, memberToken)) return json({ error: 'Member authorization required' }, 403, request);
    if (!this.env.TURN_KEY_TOKEN || !this.env.TURN_KEY_SECRET) return json({ error: 'TURN is not configured' }, 503, request);
    try {
      const response = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(this.env.TURN_KEY_TOKEN)}/credentials/generate-ice-servers`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.env.TURN_KEY_SECRET}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ttl: 3600 }),
      });
      if (!response.ok) return json({ error: 'TURN credential generation failed' }, 503, request);
      const payload = await response.json() as { iceServers?: unknown };
      const iceServers = filterVoiceIceServers(payload.iceServers);
      return iceServers ? json({ iceServers }, 200, request) : json({ error: 'TURN returned invalid credentials' }, 503, request);
    } catch {
      return json({ error: 'TURN credential service unavailable' }, 503, request);
    }
  }

  async webSocketMessage(_socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > 4096) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (isVoiceJoinMessage(parsed)) {
      await this.joinVoice(_socket, parsed);
      return;
    }
    if (isVoiceSignalMessage(parsed)) {
      await this.relayVoiceSignal(_socket, parsed);
      return;
    }
    if (isVoiceStateMessage(parsed)) {
      await this.relayVoiceState(_socket, parsed);
      return;
    }
    if (isVoiceCallMessage(parsed)) {
      await this.relayVoiceCall(_socket, parsed);
      return;
    }
    if (!isLocationMessage(parsed)) return;

    const member = await this.env.DB.prepare('SELECT display_name FROM trip_members WHERE trip_id = ? AND member_id = ?')
      .bind(this.ctx.id.name ?? 'unknown', parsed.memberId)
      .first<{ display_name: string }>();
    if (!member) return;
    const location = { ...parsed, displayName: member.display_name };
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

  private async joinVoice(socket: WebSocket, message: VoiceJoinMessage): Promise<void> {
    if (!await this.authorizeVoiceMember(message.memberId, message.memberToken)) return;
    socket.serializeAttachment({ memberId: message.memberId } satisfies VoiceAttachment);
    this.voiceCallSockets.set(message.memberId, socket);
    for (const memberId of this.activeVoiceCalls) {
      if (memberId !== message.memberId) this.sendVoice(socket, { type: 'voice-call', memberId, active: true });
    }
    for (const client of this.ctx.getWebSockets()) {
      const attachment = client.deserializeAttachment() as VoiceAttachment | null;
      if (!attachment || attachment.memberId === message.memberId) continue;
      this.sendVoice(client, { type: 'voice-peer', memberId: attachment.memberId, online: true });
      this.sendVoice(socket, { type: 'voice-peer', memberId: attachment.memberId, online: true });
    }
  }

  private async relayVoiceSignal(socket: WebSocket, message: VoiceSignalMessage): Promise<void> {
    if (!this.isAttachedMember(socket, message.memberId) || !await this.authorizeVoiceMember(message.memberId, message.memberToken)) return;
    for (const client of this.ctx.getWebSockets()) {
      const attachment = client.deserializeAttachment() as VoiceAttachment | null;
      if (attachment?.memberId === message.targetId) {
        this.sendVoice(client, { type: 'voice-signal', memberId: message.memberId, signal: message.signal });
        return;
      }
    }
  }

  private async relayVoiceState(socket: WebSocket, message: VoiceStateMessage): Promise<void> {
    if (!this.isAttachedMember(socket, message.memberId) || !await this.authorizeVoiceMember(message.memberId, message.memberToken)) return;
    for (const client of this.ctx.getWebSockets()) this.sendVoice(client, { type: 'voice-state', memberId: message.memberId, speaking: message.speaking });
  }

  private async relayVoiceCall(socket: WebSocket, message: VoiceCallMessage): Promise<void> {
    if (!this.isAttachedMember(socket, message.memberId) || !await this.authorizeVoiceMember(message.memberId, message.memberToken)) return;
    if (message.active) this.activeVoiceCalls.add(message.memberId);
    else this.activeVoiceCalls.delete(message.memberId);
    for (const client of this.ctx.getWebSockets()) this.sendVoice(client, { type: 'voice-call', memberId: message.memberId, active: message.active });
  }

  private async authorizeVoiceMember(memberId: string, memberToken: string): Promise<boolean> {
    if (!memberId || memberId.length > 80 || !memberToken || memberToken.length > 128) return false;
    const member = await this.env.DB.prepare('SELECT member_token FROM trip_members WHERE trip_id = ? AND member_id = ?')
      .bind(this.ctx.id.name ?? 'unknown', memberId)
      .first<{ member_token: string | null }>();
    return Boolean(member?.member_token && equalHash(member.member_token, memberToken));
  }

  private isAttachedMember(socket: WebSocket, memberId: string): boolean {
    return (socket.deserializeAttachment() as VoiceAttachment | null)?.memberId === memberId;
  }

  private sendVoice(socket: WebSocket, message: Record<string, unknown>): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      socket.close(1011, 'send failed');
    }
  }

  webSocketClose(socket: WebSocket): void {
    const memberId = (socket.deserializeAttachment() as VoiceAttachment | null)?.memberId;
    if (memberId) {
      if (this.voiceCallSockets.get(memberId) === socket) {
        this.voiceCallSockets.delete(memberId);
        this.activeVoiceCalls.delete(memberId);
        for (const client of this.ctx.getWebSockets()) this.sendVoice(client, { type: 'voice-call', memberId, active: false });
      }
      for (const client of this.ctx.getWebSockets()) this.sendVoice(client, { type: 'voice-peer', memberId, online: false });
    }
    socket.close();
  }

  webSocketError(socket: WebSocket): void {
    socket.close(1011, 'socket error');
  }
}

export default {
  async fetch(request: Request, env: RoutingEnv): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request) });

    if (url.pathname === '/api/geocode' && request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && !APP_ORIGINS.has(origin)) return json({ error: 'Origin not allowed' }, 403, request);
      return env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName('directions')).fetch(request);
    }

    if (url.pathname === '/api/directions' && request.method === 'POST') {
      const origin = request.headers.get('Origin');
      if (origin && !APP_ORIGINS.has(origin)) return json({ error: 'Origin not allowed' }, 403, request);
      return env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName('directions')).fetch(request);
    }

    if (url.pathname === '/api/health') return json({ ok: true, phase: 0 }, 200, request);

    if (url.pathname === '/api/auth/google' && request.method === 'POST') {
      const identity = await googleIdentity(request);
      return identity ? json({ name: identity.name, email: identity.email }, 200, request) : json({ error: 'Google sign-in required' }, 401, request);
    }

    if (url.pathname === '/api/trips' && request.method === 'POST') {
      const identity = await googleIdentity(request);
      if (!identity) return json({ error: 'Google sign-in required' }, 401, request);
      const body = await readJson(request);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      const requestedCode = typeof body?.code === 'string' ? normalizeTripCode(body.code) : '';
      const vehicleCodes = normalizeVehicleCodes(body?.vehicleCodes);
      const leaderMemberId = typeof body?.memberId === 'string' ? body.memberId.trim().slice(0, 80) : '';
      const leaderVehicleCode = typeof body?.vehicleCode === 'string' ? normalizeVehicleCode(body.vehicleCode) : '';
      if (!name) return json({ error: 'Trip name is required' }, 400, request);
      if (requestedCode && !isValidTripCode(requestedCode)) return json({ error: 'Trip code must use 4-32 letters, numbers, hyphens, or underscores' }, 400, request);
      if (!leaderMemberId || !leaderVehicleCode || !vehicleCodes.length || vehicleCodes.length > MAX_VEHICLES || !vehicleCodes.includes(leaderVehicleCode)) {
        return json({ error: 'Vehicle slots are required' }, 400, request);
      }
      const id = requestedCode || crypto.randomUUID();
      const existing = await env.DB.prepare('SELECT id FROM trips WHERE id = ?').bind(id).first();
      if (existing) return json({ error: 'Trip code already exists' }, 409, request);
      const claimedAt = new Date().toISOString();
      const memberToken = newMemberToken();
      const statements = [
        env.DB.prepare('INSERT INTO trips (id, name, leader_google_sub) VALUES (?, ?, ?)').bind(id, name, identity.sub),
        ...vehicleCodes.map((slotCode) => env.DB.prepare(
          'INSERT INTO trip_slots (trip_id, slot_code, member_id, claimed_at) VALUES (?, ?, ?, ?)',
        ).bind(id, slotCode, slotCode === leaderVehicleCode ? leaderMemberId : null, slotCode === leaderVehicleCode ? claimedAt : null)),
        env.DB.prepare('INSERT INTO trip_members (trip_id, member_id, display_name, member_token) VALUES (?, ?, ?, ?)').bind(id, leaderMemberId, leaderVehicleCode, memberToken),
      ];
      await env.DB.batch(statements);
      return json({ id, name, status: 'active', memberToken }, 201, request);
    }

    const tripMatch = url.pathname.match(/^\/api\/trips\/([A-Za-z0-9_-]{4,64})(?:\/(members|leader|routes|route-state|slots|voice-credentials))?$/);
    if (tripMatch && url.pathname.endsWith('/routes') && request.method === 'POST') {
      return env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripMatch[1])).fetch(request);
    }
    if (tripMatch && url.pathname.endsWith('/route-state') && request.method === 'POST') {
      return env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripMatch[1])).fetch(request);
    }
    if (tripMatch && url.pathname.endsWith('/voice-credentials') && request.method === 'POST') {
      return env.TRIP_ROOM.get(env.TRIP_ROOM.idFromName(tripMatch[1])).fetch(request);
    }

    if (tripMatch && url.pathname.endsWith('/slots') && request.method === 'POST') {
      const body = await readJson(request);
      const slotCode = typeof body?.slotCode === 'string' ? normalizeVehicleCode(body.slotCode) : '';
      if (!VEHICLE_CODE.test(slotCode)) return json({ error: 'Mã xe không hợp lệ.' }, 400, request);
      const tripId = tripMatch[1];
      const owner = await env.DB.prepare('SELECT leader_google_sub, leader_password_salt, leader_password_hash FROM trips WHERE id = ?')
        .bind(tripId)
        .first<{ leader_google_sub: string | null; leader_password_salt: string | null; leader_password_hash: string | null }>();
      if (!owner) return json({ error: 'Trip not found' }, 404, request);
      if (owner.leader_google_sub) {
        const identity = await googleIdentity(request);
        if (identity?.sub !== owner.leader_google_sub) return json({ error: 'Chỉ trưởng đoàn mới được chỉnh sửa chuyến đi.' }, 403, request);
      } else {
        const password = typeof body?.leaderPassword === 'string' ? body.leaderPassword : '';
        if (!owner.leader_password_salt || !owner.leader_password_hash) return json({ error: 'Leader password is not configured for this trip' }, 409, request);
        const salt = Uint8Array.from(owner.leader_password_salt.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
        if (!equalHash(await hashLeaderPassword(password, salt), owner.leader_password_hash)) return json({ error: 'Chỉ trưởng đoàn mới được chỉnh sửa chuyến đi.' }, 403, request);
      }
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM trip_slots WHERE trip_id = ?').bind(tripId).first<{ count: number }>();
      if ((count?.count ?? 0) >= MAX_VEHICLES) return json({ error: `Đoàn chỉ được tối đa ${MAX_VEHICLES} xe.` }, 409, request);
      const result = await env.DB.prepare('INSERT OR IGNORE INTO trip_slots (trip_id, slot_code) VALUES (?, ?)').bind(tripId, slotCode).run();
      if (!result.meta.changes) return json({ error: 'Mã xe đã tồn tại trong chuyến đi.' }, 409, request);
      return json({ code: slotCode, memberId: null, claimed: false }, 201, request);
    }

    if (tripMatch && url.pathname.endsWith('/slots') && request.method === 'PATCH') {
      const body = await readJson(request);
      const fromCode = typeof body?.fromCode === 'string' ? normalizeVehicleCode(body.fromCode) : '';
      const toCode = typeof body?.toCode === 'string' ? normalizeVehicleCode(body.toCode) : '';
      if (!VEHICLE_CODE.test(fromCode) || !VEHICLE_CODE.test(toCode) || fromCode === toCode) return json({ error: 'Mã xe mới không hợp lệ.' }, 400, request);
      const tripId = tripMatch[1];
      const owner = await env.DB.prepare('SELECT leader_google_sub, leader_password_salt, leader_password_hash FROM trips WHERE id = ?')
        .bind(tripId)
        .first<{ leader_google_sub: string | null; leader_password_salt: string | null; leader_password_hash: string | null }>();
      if (!owner) return json({ error: 'Trip not found' }, 404, request);
      if (owner.leader_google_sub) {
        const identity = await googleIdentity(request);
        if (identity?.sub !== owner.leader_google_sub) return json({ error: 'Chỉ trưởng đoàn mới được chỉnh sửa chuyến đi.' }, 403, request);
      } else {
        const password = typeof body?.leaderPassword === 'string' ? body.leaderPassword : '';
        if (!owner.leader_password_salt || !owner.leader_password_hash) return json({ error: 'Leader password is not configured for this trip' }, 409, request);
        const salt = Uint8Array.from(owner.leader_password_salt.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
        if (!equalHash(await hashLeaderPassword(password, salt), owner.leader_password_hash)) return json({ error: 'Chỉ trưởng đoàn mới được chỉnh sửa chuyến đi.' }, 403, request);
      }
      const source = await env.DB.prepare('SELECT member_id FROM trip_slots WHERE trip_id = ? AND slot_code = ?')
        .bind(tripId, fromCode)
        .first<{ member_id: string | null }>();
      if (!source) return json({ error: 'Không tìm thấy mã xe cần đổi.' }, 404, request);
      const target = await env.DB.prepare('SELECT 1 AS found FROM trip_slots WHERE trip_id = ? AND slot_code = ?')
        .bind(tripId, toCode)
        .first();
      if (target) return json({ error: 'Mã xe mới đã tồn tại.' }, 409, request);
      const statements = [env.DB.prepare('UPDATE trip_slots SET slot_code = ? WHERE trip_id = ? AND slot_code = ?').bind(toCode, tripId, fromCode)];
      if (source.member_id) statements.push(env.DB.prepare('UPDATE trip_members SET display_name = ? WHERE trip_id = ? AND member_id = ?').bind(toCode, tripId, source.member_id));
      await env.DB.batch(statements);
      return json({ previousCode: fromCode, code: toCode, memberId: source.member_id }, 200, request);
    }

    if (tripMatch && url.pathname === `/api/trips/${tripMatch[1]}` && request.method === 'PATCH') {
      const body = await readJson(request);
      const name = typeof body?.name === 'string' ? body.name.trim().slice(0, 80) : '';
      if (!name) return json({ error: 'Tên chuyến đi không được để trống.' }, 400, request);
      const tripId = tripMatch[1];
      const owner = await env.DB.prepare('SELECT leader_google_sub, leader_password_salt, leader_password_hash FROM trips WHERE id = ?')
        .bind(tripId)
        .first<{ leader_google_sub: string | null; leader_password_salt: string | null; leader_password_hash: string | null }>();
      if (!owner) return json({ error: 'Trip not found' }, 404, request);
      if (owner.leader_google_sub) {
        const identity = await googleIdentity(request);
        if (identity?.sub !== owner.leader_google_sub) return json({ error: 'Chỉ trưởng đoàn mới được chỉnh sửa chuyến đi.' }, 403, request);
      } else {
        const password = typeof body?.leaderPassword === 'string' ? body.leaderPassword : '';
        if (!owner.leader_password_salt || !owner.leader_password_hash) return json({ error: 'Leader password is not configured for this trip' }, 409, request);
        const salt = Uint8Array.from(owner.leader_password_salt.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
        if (!equalHash(await hashLeaderPassword(password, salt), owner.leader_password_hash)) return json({ error: 'Chỉ trưởng đoàn mới được chỉnh sửa chuyến đi.' }, 403, request);
      }
      await env.DB.prepare('UPDATE trips SET name = ? WHERE id = ?').bind(name, tripId).run();
      return json({ id: tripId, name }, 200, request);
    }

    if (tripMatch && url.pathname === `/api/trips/${tripMatch[1]}` && request.method === 'GET') {
      const trip = await env.DB.prepare('SELECT id, name, status, created_at, leader_password_hash IS NOT NULL AS has_leader_password, leader_google_sub IS NOT NULL AS has_google_leader FROM trips WHERE id = ?').bind(tripMatch[1]).first();
      if (!trip) return json({ error: 'Trip not found' }, 404, request);
      const slots = await env.DB.prepare('SELECT slot_code, member_id FROM trip_slots WHERE trip_id = ? ORDER BY rowid ASC')
        .bind(tripMatch[1])
        .all<{ slot_code: string; member_id: string | null }>();
      return json({ ...trip, slots: slots.results.map((slot) => ({ code: slot.slot_code, memberId: slot.member_id, claimed: Boolean(slot.member_id) })) }, 200, request);
    }

    if (tripMatch && url.pathname.endsWith('/members') && request.method === 'GET') {
      const members = await env.DB.prepare('SELECT member_id, display_name, joined_at FROM trip_members WHERE trip_id = ? ORDER BY joined_at ASC')
        .bind(tripMatch[1])
        .all();
      return json({ members: members.results }, 200, request);
    }

    if (tripMatch && url.pathname.endsWith('/leader') && request.method === 'POST') {
      const body = await readJson(request);
      const password = typeof body?.password === 'string' ? body.password : '';
      const owner = await env.DB.prepare('SELECT leader_google_sub FROM trips WHERE id = ?').bind(tripMatch[1]).first<{ leader_google_sub: string | null }>();
      if (owner?.leader_google_sub) {
        const identity = await googleIdentity(request);
        return identity?.sub === owner.leader_google_sub ? json({ leader: true }, 200, request) : json({ error: 'Google account does not own this trip' }, 403, request);
      }

      const trip = await env.DB.prepare('SELECT leader_password_salt, leader_password_hash FROM trips WHERE id = ?')
        .bind(tripMatch[1])
        .first<{ leader_password_salt: string | null; leader_password_hash: string | null }>();
      if (!trip) return json({ error: 'Trip not found' }, 404, request);
      if (!trip.leader_password_salt || !trip.leader_password_hash) return json({ error: 'Leader password is not configured for this trip' }, 409, request);
      const salt = Uint8Array.from(trip.leader_password_salt.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
      if (!equalHash(await hashLeaderPassword(password, salt), trip.leader_password_hash)) return json({ error: 'Invalid leader password' }, 403, request);
      return json({ leader: true }, 200, request);
    }

    if (tripMatch && url.pathname.endsWith('/members') && request.method === 'POST') {
      const body = await readJson(request);
      const memberId = typeof body?.memberId === 'string' ? body.memberId.trim().slice(0, 80) : '';
      const slotCode = typeof body?.slotCode === 'string' ? normalizeVehicleCode(body.slotCode) : '';
      const suppliedToken = typeof body?.memberToken === 'string' ? body.memberToken : '';
      if (!memberId || !slotCode) return json({ error: 'Vehicle code is required' }, 400, request);
      const trip = await env.DB.prepare('SELECT id FROM trips WHERE id = ?').bind(tripMatch[1]).first();
      if (!trip) return json({ error: 'Trip not found' }, 404, request);
      const slot = await env.DB.prepare('SELECT member_id FROM trip_slots WHERE trip_id = ? AND slot_code = ?')
        .bind(tripMatch[1], slotCode)
        .first<{ member_id: string | null }>();
      if (!slot) return json({ error: 'Vehicle code not found' }, 404, request);
      if (slot.member_id && slot.member_id !== memberId) return json({ error: 'Vehicle code already taken' }, 409, request);
      const otherSlot = await env.DB.prepare('SELECT slot_code FROM trip_slots WHERE trip_id = ? AND member_id = ? AND slot_code <> ?')
        .bind(tripMatch[1], memberId, slotCode)
        .first();
      if (otherSlot) return json({ error: 'This device already selected another vehicle' }, 409, request);
      const existingMember = await env.DB.prepare('SELECT member_token FROM trip_members WHERE trip_id = ? AND member_id = ?')
        .bind(tripMatch[1], memberId)
        .first<{ member_token: string | null }>();
      if (existingMember?.member_token && existingMember.member_token !== suppliedToken) return json({ error: 'This device session is no longer authorized' }, 403, request);
      const memberToken = existingMember?.member_token ?? newMemberToken();
      const claim = await env.DB.prepare(
        'UPDATE trip_slots SET member_id = ?, claimed_at = ? WHERE trip_id = ? AND slot_code = ? AND (member_id IS NULL OR member_id = ?)',
      ).bind(memberId, new Date().toISOString(), tripMatch[1], slotCode, memberId).run();
      if (!claim.meta.changes) return json({ error: 'Vehicle code already taken' }, 409, request);
      await env.DB.prepare(
        'INSERT INTO trip_members (trip_id, member_id, display_name, member_token) VALUES (?, ?, ?, ?) ON CONFLICT(trip_id, member_id) DO UPDATE SET display_name = excluded.display_name, member_token = COALESCE(trip_members.member_token, excluded.member_token)',
      ).bind(tripMatch[1], memberId, slotCode, memberToken).run();
      return json({ memberId, displayName: slotCode, slotCode, memberToken }, 201, request);
    }

    if (tripMatch && url.pathname.endsWith('/members') && request.method === 'DELETE') {
      const body = await readJson(request);
      const requesterMemberId = typeof body?.requesterMemberId === 'string' ? body.requesterMemberId.trim().slice(0, 80) : '';
      const targetMemberId = typeof body?.targetMemberId === 'string' ? body.targetMemberId.trim().slice(0, 80) : '';
      const requesterToken = typeof body?.requesterToken === 'string' ? body.requesterToken : '';
      const password = typeof body?.leaderPassword === 'string' ? body.leaderPassword : '';
      if (!requesterMemberId || !targetMemberId) return json({ error: 'Member id is required' }, 400, request);
      if (requesterMemberId === targetMemberId && !password && !request.headers.has('Authorization')) {
        const member = await env.DB.prepare('SELECT member_token FROM trip_members WHERE trip_id = ? AND member_id = ?')
          .bind(tripMatch[1], targetMemberId)
          .first<{ member_token: string | null }>();
        if (member?.member_token && requesterToken !== member.member_token) return json({ error: 'This device session is no longer authorized' }, 403, request);
      } else {
        const owner = await env.DB.prepare('SELECT leader_google_sub FROM trips WHERE id = ?').bind(tripMatch[1]).first<{ leader_google_sub: string | null }>();
        if (owner?.leader_google_sub) {
          const identity = await googleIdentity(request);
          if (identity?.sub !== owner.leader_google_sub) return json({ error: 'Google account does not own this trip' }, 403, request);
        } else {
          const trip = await env.DB.prepare('SELECT leader_password_salt, leader_password_hash FROM trips WHERE id = ?')
            .bind(tripMatch[1])
            .first<{ leader_password_salt: string | null; leader_password_hash: string | null }>();
          if (!trip) return json({ error: 'Trip not found' }, 404, request);
          if (!trip.leader_password_salt || !trip.leader_password_hash) return json({ error: 'Leader password is not configured for this trip' }, 409, request);
          const salt = Uint8Array.from(trip.leader_password_salt.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
          if (!equalHash(await hashLeaderPassword(password, salt), trip.leader_password_hash)) return json({ error: 'Leader password required' }, 403, request);
        }
      }
      await env.DB.batch([
        env.DB.prepare('UPDATE trip_slots SET member_id = NULL, claimed_at = NULL WHERE trip_id = ? AND member_id = ?').bind(tripMatch[1], targetMemberId),
        env.DB.prepare('DELETE FROM trip_members WHERE trip_id = ? AND member_id = ?').bind(tripMatch[1], targetMemberId),
      ]);
      return json({ ok: true }, 200, request);
    }

    const socketMatch = url.pathname.match(/^\/ws\/([A-Za-z0-9_-]{4,64})$/);
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
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'DELETE, GET, POST, OPTIONS',
    'access-control-allow-origin': APP_ORIGINS.has(requestOrigin) ? requestOrigin : 'https://weemap.vercel.app',
    'vary': 'Origin',
  };
}

const UUID_CODE = /^[0-9a-f-]{36}$/i;
const CUSTOM_CODE = /^[A-Z0-9_-]{4,32}$/;
const VEHICLE_CODE = /^[A-Z0-9_-]{1,20}$/;
const MAX_VEHICLES = 20;

function normalizeTripCode(value: string): string {
  const trimmed = value.trim();
  return UUID_CODE.test(trimmed) ? trimmed.toLowerCase() : trimmed.toUpperCase();
}

function isValidTripCode(value: string): boolean {
  const normalized = normalizeTripCode(value);
  return UUID_CODE.test(normalized) || CUSTOM_CODE.test(normalized);
}

function normalizeVehicleCode(value: string): string {
  return value.trim().toUpperCase();
}

function normalizeVehicleCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const codes = value.filter((code): code is string => typeof code === 'string').map(normalizeVehicleCode);
  if (codes.length !== new Set(codes).size || codes.some((code) => !VEHICLE_CODE.test(code))) return [];
  return codes;
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

function isVoiceJoinMessage(value: unknown): value is VoiceJoinMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VoiceJoinMessage>;
  return item.type === 'voice-join'
    && typeof item.memberId === 'string' && item.memberId.length <= 80
    && typeof item.memberToken === 'string' && item.memberToken.length <= 128;
}

function isVoiceSignalMessage(value: unknown): value is VoiceSignalMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VoiceSignalMessage>;
  return item.type === 'voice-signal'
    && typeof item.memberId === 'string' && item.memberId.length <= 80
    && typeof item.memberToken === 'string' && item.memberToken.length <= 128
    && typeof item.targetId === 'string' && item.targetId.length <= 80
    && typeof item.signal === 'object' && item.signal !== null;
}

function isVoiceStateMessage(value: unknown): value is VoiceStateMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VoiceStateMessage>;
  return item.type === 'voice-state'
    && typeof item.memberId === 'string' && item.memberId.length <= 80
    && typeof item.memberToken === 'string' && item.memberToken.length <= 128
    && typeof item.speaking === 'boolean';
}

function isVoiceCallMessage(value: unknown): value is VoiceCallMessage {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<VoiceCallMessage>;
  return item.type === 'voice-call'
    && typeof item.memberId === 'string' && item.memberId.length <= 80
    && typeof item.memberToken === 'string' && item.memberToken.length <= 128
    && typeof item.active === 'boolean';
}

function filterVoiceIceServers(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const servers = value.flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const server = item as Record<string, unknown>;
    const urls = Array.isArray(server.urls)
      ? server.urls.filter((url): url is string => typeof url === 'string' && !/:53(?:\?|$)/.test(url))
      : typeof server.urls === 'string' && !/:53(?:\?|$)/.test(server.urls) ? server.urls : null;
    return urls ? [{ ...server, urls }] : [];
  });
  return servers.length ? servers : null;
}

async function loadTripLocations(env: RoutingEnv, tripId: string): Promise<LocationMessage[]> {
    // shortcut: query trip history on connect; add a latest-location table if the event log grows.
    const locations = await env.DB.prepare(
      `SELECT e.member_id, m.display_name, e.latitude, e.longitude, e.accuracy, e.speed_kmh, e.recorded_at
       FROM location_events AS e
       JOIN (
         SELECT member_id, MAX(id) AS id FROM location_events WHERE trip_id = ? GROUP BY member_id
       ) AS latest ON latest.id = e.id
       JOIN trip_members AS m ON m.trip_id = e.trip_id AND m.member_id = e.member_id
       WHERE e.trip_id = ?`,
    ).bind(tripId, tripId)
      .all<{ member_id: string; display_name: string; latitude: number; longitude: number; accuracy: number | null; speed_kmh: number | null; recorded_at: string }>();
    return locations.results.map((row) => ({ type: 'location', memberId: row.member_id, displayName: row.display_name, latitude: row.latitude, longitude: row.longitude, accuracy: row.accuracy ?? undefined, speedKmh: row.speed_kmh ?? undefined, recordedAt: row.recorded_at }));
}
