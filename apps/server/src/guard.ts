/**
 * Authentication and authorisation for the API surface.
 *
 * Two kinds of caller:
 *   - the owner (console / voice), authenticating with the owner passcode
 *   - a paired Android device, authenticating with the device bridge token
 *
 * There is no anonymous access to anything that reads or changes data. If no
 * passcode is configured the server says so loudly at startup rather than
 * pretending to be secure — see `describeAuth()`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyFirebaseIdToken, type Principal } from '@xacheus/core';

export interface GuardOptions {
  ownerPasscode: string;
  deviceToken: string;
  /** Set when the process is bound to something other than loopback. */
  exposed: boolean;
  /** Firebase project id — enables Firebase ID token sign-in for the console. */
  firebaseProjectId?: string;
  /** When set, only this email may sign in through Firebase. */
  ownerEmail?: string;
}

export interface GuardedRequest extends FastifyRequest {
  principal?: Principal;
}

export function describeAuth(options: GuardOptions): { mode: string; warning?: string } {
  if (!options.ownerPasscode && !options.deviceToken) {
    return {
      mode: 'OPEN (no credentials configured)',
      warning:
        'XACHEUS_OWNER_PASSCODE is not set, so the API accepts unauthenticated requests. Set it in your .env before this server is reachable from anywhere but your own machine.',
    };
  }
  return {
    mode: options.ownerPasscode ? 'owner passcode' : 'device token only',
    warning: options.exposed && !options.ownerPasscode
      ? 'The server is listening on a public interface with no owner passcode. Set XACHEUS_OWNER_PASSCODE.'
      : undefined,
  };
}

/** Extract a bearer token from the Authorization header, a query string or a cookie. */
export function tokenFrom(request: FastifyRequest): { token: string; deviceId?: string; deviceName?: string } {
  const header = request.headers.authorization ?? '';
  let token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const query = (request.query ?? {}) as Record<string, string>;
  if (!token && query.token) token = String(query.token);
  if (!token && typeof request.headers['x-xacheus-token'] === 'string') {
    token = request.headers['x-xacheus-token'];
  }
  return {
    token,
    deviceId: query.deviceId ? String(query.deviceId) : undefined,
    deviceName: query.name ? String(query.name) : undefined,
  };
}

export async function authenticate(request: FastifyRequest, options: GuardOptions): Promise<Principal | null> {
  const { token, deviceId, deviceName } = tokenFrom(request);

  // No credentials configured → single-owner local mode.
  if (!options.ownerPasscode && !options.deviceToken && !options.firebaseProjectId) {
    return { id: 'owner', role: 'owner', displayName: 'Owner' };
  }
  if (options.deviceToken && token && timingSafeEquals(token, options.deviceToken)) {
    return {
      id: deviceId ?? 'device',
      role: 'device',
      displayName: deviceName ?? 'Android device',
      deviceId: deviceId ?? 'device',
    };
  }
  if (options.ownerPasscode && token && timingSafeEquals(token, options.ownerPasscode)) {
    return { id: 'owner', role: 'owner', displayName: 'Owner' };
  }

  // Firebase ID token (console sign-in). Verified against Google's public keys.
  if (options.firebaseProjectId && token.split('.').length === 3) {
    const result = await verifyFirebaseIdToken(token, options.firebaseProjectId);
    if (result.ok) {
      const email = result.email ?? result.uid ?? 'firebase-user';
      if (options.ownerEmail && email.toLowerCase() !== options.ownerEmail.toLowerCase()) {
        return null; // authenticated with Firebase, but not the owner
      }
      return { id: result.uid ?? 'firebase-user', role: 'owner', displayName: email };
    }
  }
  return null;
}

function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Fastify preHandler that rejects unauthenticated calls. */
export function requirePrincipal(options: GuardOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const principal = await authenticate(request, options);
    if (!principal) {
      await reply.code(401).send({
        error: 'unauthorized',
        message: 'Provide a valid owner passcode or device token.',
      });
      return;
    }
    (request as GuardedRequest).principal = principal;
  };
}

export function principalOf(request: FastifyRequest): Principal {
  const principal = (request as GuardedRequest).principal;
  if (!principal) throw new Error('Principal missing — route is not guarded.');
  return principal;
}
