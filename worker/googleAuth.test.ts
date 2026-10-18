import { describe, it, expect } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { GOOGLE_CLIENT_ID, verifyGoogleToken } from './googleAuth';

const keys = await generateKeyPair('RS256');
const publicKey = await exportJWK(keys.publicKey);
const keySet = createLocalJWKSet({ keys: [{ ...publicKey, kid: 'test' }] });
async function token(audience = GOOGLE_CLIENT_ID, expiry = '1h', issuer = 'https://accounts.google.com') {
  return new SignJWT({ email: 'leader@example.com', email_verified: true })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' }).setSubject('google-owner')
    .setIssuer(issuer).setAudience(audience).setIssuedAt().setExpirationTime(expiry).sign(keys.privateKey);
}

describe('Google identity verification', () => {
  it('accepts a signed token for WeeMap', async () => {
    expect((await verifyGoogleToken(await token(), keySet)).sub).toBe('google-owner');
  });
  it('rejects a different client, expired token, and wrong issuer', async () => {
    for (const value of [await token('another-client'), await token(GOOGLE_CLIENT_ID, '-1h'), await token(GOOGLE_CLIENT_ID, '1h', 'https://attacker.example')]) {
      await expect(verifyGoogleToken(value, keySet)).rejects.toThrow();
    }
  });
  it('rejects a forged signature', async () => {
    const value = await token();
    const parts = value.split('.');
    parts[2] = (parts[2][0] === 'a' ? 'b' : 'a') + parts[2].slice(1);
    await expect(verifyGoogleToken(parts.join('.'), keySet)).rejects.toThrow();
  });
});
