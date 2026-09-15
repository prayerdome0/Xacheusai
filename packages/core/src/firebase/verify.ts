/**
 * Firebase ID token verification.
 *
 * Implemented directly against Google's published public certificates, with no
 * Admin SDK dependency, so the backend stays small. This is what lets the console
 * and the Android app sign in with Firebase Auth and present the resulting ID
 * token to the API.
 *
 * Checks performed (all of them matter):
 *   - signature against Google's rotating x509 certs, matched by `kid`
 *   - `iss` is https://securetoken.google.com/<projectId>
 *   - `aud` is <projectId>
 *   - `exp` / `iat` are sane, `sub` is non-empty (Firebase always sets it to the uid)
 */
import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface CacheEntry {
  certs: Record<string, string>;
  keys: Record<string, KeyObject>;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

async function loadCerts(): Promise<CacheEntry> {
  if (cache && Date.now() < cache.expiresAt) return cache;

  const response = await fetch(CERT_URL, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`Could not fetch Firebase signing certificates (HTTP ${response.status}).`);
  const certs = (await response.json()) as Record<string, string>;
  const keys: Record<string, KeyObject> = {};
  for (const [kid, pem] of Object.entries(certs)) {
    try {
      keys[kid] = createPublicKey(pem);
    } catch {
      /* skip unusable certs */
    }
  }
  const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1] ?? 3600);
  cache = { certs, keys, expiresAt: Date.now() + Math.max(maxAge - 60, 300) * 1000 };
  return cache;
}

export interface FirebaseTokenResult {
  ok: boolean;
  uid?: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  error?: string;
}

export async function verifyFirebaseIdToken(idToken: string, projectId: string): Promise<FirebaseTokenResult> {
  const parts = idToken.split('.');
  if (parts.length !== 3) return { ok: false, error: 'Not a JWT.' };

  let header: { alg?: string; kid?: string };
  let payload: Record<string, any>;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, error: 'Malformed token.' };
  }

  if (header.alg !== 'RS256' || !header.kid) return { ok: false, error: 'Unsupported signing algorithm.' };
  if (!projectId) return { ok: false, error: 'No Firebase project id configured.' };

  let entry: CacheEntry;
  try {
    entry = await loadCerts();
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  const key = entry.keys[header.kid];
  if (!key) return { ok: false, error: `Unknown signing key ${header.kid}.` };

  const signingInput = `${parts[0]}.${parts[1]}`;
  const signature = Buffer.from(parts[2]!, 'base64url');
  const signatureValid = cryptoVerify('RSA-SHA256', Buffer.from(signingInput), key, signature);
  if (!signatureValid) return { ok: false, error: 'Signature verification failed.' };

  const now = Math.floor(Date.now() / 1000);
  if (payload.iss !== `https://securetoken.google.com/${projectId}`) {
    return { ok: false, error: `Wrong issuer "${payload.iss}".` };
  }
  if (payload.aud !== projectId) return { ok: false, error: `Wrong audience "${payload.aud}".` };
  if (typeof payload.exp !== 'number' || payload.exp < now) return { ok: false, error: 'Token expired.' };
  if (typeof payload.iat !== 'number' || payload.iat > now + 300) return { ok: false, error: 'Token issued in the future.' };
  if (!payload.sub) return { ok: false, error: 'Token has no subject.' };

  return {
    ok: true,
    uid: payload.sub,
    email: payload.email,
    emailVerified: payload.email_verified,
    name: payload.name,
  };
}
