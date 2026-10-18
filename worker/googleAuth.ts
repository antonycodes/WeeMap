import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
export const GOOGLE_CLIENT_ID = '271810624076-8k55732jc0f0krn8p3uhcfnac6sv6lk2.apps.googleusercontent.com';

export async function verifyGoogleToken(token: string, keys: JWTVerifyGetKey = googleKeys) {
  const { payload } = await jwtVerify(token, keys, {
    audience: GOOGLE_CLIENT_ID,
    issuer: ['https://accounts.google.com', 'accounts.google.com'],
    algorithms: ['RS256'],
    requiredClaims: ['sub', 'exp', 'iat'],
  });
  if (!payload.sub || typeof payload.email !== 'string' || payload.email_verified !== true) throw new Error('Invalid Google identity');
  return { sub: payload.sub, email: payload.email, name: typeof payload.name === 'string' ? payload.name : payload.email };
}

export async function googleIdentity(request: Request) {
  const header = request.headers.get('Authorization');
  if (!header?.startsWith('Bearer ') || header.length > 8192) return null;
  try {
    return await verifyGoogleToken(header.slice(7));
  } catch {
    return null;
  }
}
