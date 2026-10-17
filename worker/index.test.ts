import { beforeAll, describe, expect, it, vi } from 'vitest';
import worker from './index';

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
