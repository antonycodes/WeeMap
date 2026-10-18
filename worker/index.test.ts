import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker, { TripRoom } from './index';

const password = 'trip-password';
const salt = new Uint8Array(16).fill(7);
let passwordHash: string;

beforeAll(async () => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
  passwordHash = [...new Uint8Array(bits)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
});

async function removeMember(body: Record<string, string>) {
  const batch = vi.fn().mockResolvedValue([]);
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('SELECT member_token')
            ? { member_token: 'valid-token' }
            : { leader_password_salt: '07'.repeat(16), leader_password_hash: passwordHash },
        }),
      }),
      batch,
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const response = await worker.fetch(new Request('https://example.com/api/trips/TEST/members', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  return { response, batch };
}

describe('trip member removal authorization', () => {
  it('rejects an expired device token without deleting membership', async () => {
    const { response, batch } = await removeMember({ requesterMemberId: 'car-2', targetMemberId: 'car-2', requesterToken: 'expired' });
    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });

  it('lets an authorized member release their own vehicle', async () => {
    const { response, batch } = await removeMember({ requesterMemberId: 'car-2', targetMemberId: 'car-2', requesterToken: 'valid-token' });
    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
  });

  it('lets a leader remove their own expired session with the trip password', async () => {
    const { response, batch } = await removeMember({ requesterMemberId: 'car-2', targetMemberId: 'car-2', leaderPassword: password });
    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
  });

  it('lets a leader remove another vehicle with the trip password', async () => {
    const { response, batch } = await removeMember({ requesterMemberId: 'car-1', targetMemberId: 'car-2', leaderPassword: password });
    expect(response.status).toBe(200);
    expect(batch).toHaveBeenCalledOnce();
  });

  it('rejects an incorrect leader password without deleting membership', async () => {
    const { response, batch } = await removeMember({ requesterMemberId: 'car-1', targetMemberId: 'car-2', leaderPassword: 'wrong-password' });
    expect(response.status).toBe(403);
    expect(batch).not.toHaveBeenCalled();
  });
});

async function addVehicle(body: Record<string, string>) {
  const insert = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => sql.includes('COUNT(*)')
            ? { count: 1 }
            : { leader_google_sub: null, leader_password_salt: '07'.repeat(16), leader_password_hash: passwordHash },
          run: insert,
        }),
      }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const response = await worker.fetch(new Request('https://example.com/api/trips/TEST/slots', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }), env);
  return { response, insert };
}

describe('trip vehicle slot management', () => {
  it('lets the leader add a vehicle slot', async () => {
    const { response, insert } = await addVehicle({ slotCode: 'XE-03', leaderPassword: password });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ code: 'XE-03', claimed: false });
    expect(insert).toHaveBeenCalledOnce();
  });

  it('rejects a vehicle slot change with the wrong leader password', async () => {
    const { response, insert } = await addVehicle({ slotCode: 'XE-03', leaderPassword: 'wrong-password' });
    expect(response.status).toBe(403);
    expect(insert).not.toHaveBeenCalled();
  });
});

it('lets the leader rename a trip', async () => {
  const update = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: () => ({
          first: async () => ({ leader_google_sub: null, leader_password_salt: '07'.repeat(16), leader_password_hash: passwordHash }),
          run: update,
        }),
      }),
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  const response = await worker.fetch(new Request('https://example.com/api/trips/TEST', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Chuyến mới', leaderPassword: password }),
  }), env);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ name: 'Chuyến mới' });
  expect(update).toHaveBeenCalledOnce();
});

it('relays an authorized voice call state to every connected vehicle', async () => {
  const callerSend = vi.fn();
  const otherSend = vi.fn();
  const caller = {
    deserializeAttachment: () => ({ memberId: 'car-1' }),
    send: callerSend,
    close: vi.fn(),
  } as unknown as WebSocket;
  const other = {
    deserializeAttachment: () => ({ memberId: 'car-2' }),
    send: otherSend,
    close: vi.fn(),
  } as unknown as WebSocket;
  const ctx = {
    id: { name: 'TEST' },
    getWebSockets: () => [caller, other],
  } as unknown as ConstructorParameters<typeof TripRoom>[0];
  const env = {
    DB: { prepare: () => ({ bind: () => ({ first: async () => ({ member_token: 'valid-token' }) }) }) },
  } as unknown as ConstructorParameters<typeof TripRoom>[1];
  const room = new TripRoom(ctx, env);

  await room.webSocketMessage(caller, JSON.stringify({ type: 'voice-call', memberId: 'car-1', memberToken: 'valid-token', active: true }));

  expect(JSON.parse(otherSend.mock.calls[0][0])).toEqual({ type: 'voice-call', memberId: 'car-1', active: true });
});
