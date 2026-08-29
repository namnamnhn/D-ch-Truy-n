import {
  createHash,
  createHmac,
  timingSafeEqual,
} from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { Plugin } from 'vite';
import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_STATUS_PATH,
  type AuthStatusCode,
  type AuthStatusResponse,
} from '../shared/authContract';
import {
  DECLARED_EDITION,
  evaluateEditionEntitlement,
  type EditionDeclaration,
  type EntitlementDecision,
} from '../shared/editionContract';

const SESSION_COOKIE = 'app_session';
const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_AUTH_BODY_BYTES = 4 * 1024;
const MAX_ACCESS_CODE_LENGTH = 256;
const DEFAULT_MAX_LOGIN_ATTEMPTS = 5;
const DEFAULT_RATE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;

interface SessionClaims {
  v: 1;
  iat: number;
  exp: number;
  edition: 'full' | 'lite';
}

interface RateEntry {
  failures: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export interface AuthSessionOptions {
  env?: NodeJS.ProcessEnv;
  edition?: EditionDeclaration;
  now?: () => number;
  maxLoginAttempts?: number;
  rateWindowMs?: number;
  blockMs?: number;
}

export interface SessionInspection {
  response: AuthStatusResponse;
  claims?: SessionClaims;
}

const messageFor = (status: AuthStatusCode): string => ({
  AUTHENTICATED: 'The server session is authenticated.',
  AUTH_REQUIRED: 'Authentication is required.',
  INVALID_CODE: 'The access code is incorrect.',
  AUTH_NOT_CONFIGURED: 'Server access authentication is not configured.',
  SESSION_EXPIRED: 'The server session has expired.',
  ENTITLEMENT_EXPIRED: 'This edition entitlement is not currently valid.',
  RATE_LIMITED: 'Too many access attempts. Try again later.',
  UNAUTHORIZED_REQUEST: 'The authentication request is not allowed.',
  SERVER_UNAVAILABLE: 'The authentication server is unavailable.',
})[status];

const boundedSessionTtl = (raw: string | undefined): number => {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 60 && value <= 24 * 60 * 60
    ? value
    : DEFAULT_SESSION_TTL_SECONDS;
};

const parseCookies = (request: IncomingMessage): Map<string, string> => {
  const cookies = new Map<string, string>();
  for (const part of (request.headers.cookie || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
};

const safeEqual = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && timingSafeEqual(left, right);

const responseFor = (
  status: AuthStatusCode,
  entitlement: EntitlementDecision,
  requiresCode: boolean,
  sessionExpiresAt?: number,
): AuthStatusResponse => ({
  authenticated: status === 'AUTHENTICATED',
  status,
  message: messageFor(status),
  requiresCode,
  entitlement,
  ...(sessionExpiresAt ? { sessionExpiresAt } : {}),
});

export class AuthSessionAuthority {
  private readonly env: NodeJS.ProcessEnv;
  private readonly edition: EditionDeclaration;
  private readonly now: () => number;
  private readonly loginAttempts = new Map<string, RateEntry>();
  private readonly maxLoginAttempts: number;
  private readonly rateWindowMs: number;
  private readonly blockMs: number;

  constructor(options: AuthSessionOptions = {}) {
    this.env = options.env || process.env;
    this.edition = options.edition || DECLARED_EDITION;
    this.now = options.now || Date.now;
    this.maxLoginAttempts = options.maxLoginAttempts || DEFAULT_MAX_LOGIN_ATTEMPTS;
    this.rateWindowMs = options.rateWindowMs || DEFAULT_RATE_WINDOW_MS;
    this.blockMs = options.blockMs || DEFAULT_BLOCK_MS;
  }

  getEntitlement(): EntitlementDecision {
    return evaluateEditionEntitlement(this.edition, this.now());
  }

  requiresCode(): boolean {
    return this.edition.requireCode;
  }

  private getAccessHash(): Buffer | null {
    if (!this.edition.requireCode) return Buffer.alloc(0);
    const value = this.env.APP_ACCESS_CODE_HASH?.trim().toLowerCase() || '';
    return /^[a-f0-9]{64}$/.test(value) ? Buffer.from(value, 'hex') : null;
  }

  private getSigningSecret(): string | null {
    const value = this.env.SESSION_SIGNING_SECRET || '';
    return Buffer.byteLength(value, 'utf8') >= 32 ? value : null;
  }

  isConfigured(): boolean {
    return this.getSigningSecret() !== null && this.getAccessHash() !== null;
  }

  private sign(encodedClaims: string, secret: string): string {
    return createHmac('sha256', secret).update(encodedClaims).digest('base64url');
  }

  private encodeSession(claims: SessionClaims, secret: string): string {
    const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    return `${encodedClaims}.${this.sign(encodedClaims, secret)}`;
  }

  private decodeSession(value: string, secret: string): { claims?: SessionClaims; expired?: boolean } {
    const [encodedClaims, signature, extra] = value.split('.');
    if (!encodedClaims || !signature || extra) return {};
    const expected = this.sign(encodedClaims, secret);
    if (!safeEqual(Buffer.from(signature), Buffer.from(expected))) return {};
    try {
      const claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as SessionClaims;
      if (
        claims.v !== 1
        || !Number.isInteger(claims.iat)
        || !Number.isInteger(claims.exp)
        || claims.exp <= claims.iat
        || !['full', 'lite'].includes(claims.edition)
      ) return {};
      if (claims.exp <= this.now()) return { expired: true };
      if (claims.edition !== this.edition.edition) return {};
      return { claims };
    } catch {
      return {};
    }
  }

  inspect(request: IncomingMessage): SessionInspection {
    const entitlement = this.getEntitlement();
    if (!this.isConfigured()) {
      return { response: responseFor('AUTH_NOT_CONFIGURED', entitlement, this.edition.requireCode) };
    }
    if (!entitlement.valid) {
      return { response: responseFor('ENTITLEMENT_EXPIRED', entitlement, this.edition.requireCode) };
    }
    const cookie = parseCookies(request).get(SESSION_COOKIE);
    if (!cookie) return { response: responseFor('AUTH_REQUIRED', entitlement, this.edition.requireCode) };
    const decoded = this.decodeSession(cookie, this.getSigningSecret()!);
    if (decoded.expired) {
      return { response: responseFor('SESSION_EXPIRED', entitlement, this.edition.requireCode) };
    }
    if (!decoded.claims) {
      return { response: responseFor('AUTH_REQUIRED', entitlement, this.edition.requireCode) };
    }
    return {
      claims: decoded.claims,
      response: responseFor('AUTHENTICATED', entitlement, this.edition.requireCode, decoded.claims.exp),
    };
  }

  authorizeRequest = async (request: IncomingMessage): Promise<boolean> => this.inspect(request).response.authenticated;

  private rateKey(request: IncomingMessage): string {
    return request.socket.remoteAddress || 'unknown';
  }

  private rateEntry(request: IncomingMessage): RateEntry | undefined {
    const key = this.rateKey(request);
    const entry = this.loginAttempts.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (entry.blockedUntil > now) return entry;
    if (now - entry.windowStartedAt >= this.rateWindowMs) {
      this.loginAttempts.delete(key);
      return undefined;
    }
    return entry;
  }

  isRateLimited(request: IncomingMessage): boolean {
    return (this.rateEntry(request)?.blockedUntil || 0) > this.now();
  }

  private recordFailure(request: IncomingMessage): void {
    const key = this.rateKey(request);
    const now = this.now();
    const current = this.rateEntry(request) || { failures: 0, windowStartedAt: now, blockedUntil: 0 };
    current.failures += 1;
    if (current.failures >= this.maxLoginAttempts) current.blockedUntil = now + this.blockMs;
    this.loginAttempts.set(key, current);
    if (this.loginAttempts.size > 1_000) this.loginAttempts.delete(this.loginAttempts.keys().next().value!);
  }

  login(request: IncomingMessage, code: string): { response: AuthStatusResponse; cookie?: string } {
    const entitlement = this.getEntitlement();
    if (!this.isConfigured()) {
      return { response: responseFor('AUTH_NOT_CONFIGURED', entitlement, this.edition.requireCode) };
    }
    if (!entitlement.valid) {
      return { response: responseFor('ENTITLEMENT_EXPIRED', entitlement, this.edition.requireCode) };
    }
    if (this.isRateLimited(request)) {
      return { response: responseFor('RATE_LIMITED', entitlement, this.edition.requireCode) };
    }

    const expectedHash = this.getAccessHash()!;
    const actualHash = createHash('sha256').update(code, 'utf8').digest();
    if (this.edition.requireCode && !safeEqual(actualHash, expectedHash)) {
      this.recordFailure(request);
      return { response: responseFor('INVALID_CODE', entitlement, this.edition.requireCode) };
    }

    this.loginAttempts.delete(this.rateKey(request));
    const now = this.now();
    const ttlSeconds = boundedSessionTtl(this.env.SESSION_TTL_SECONDS);
    const entitlementLimit = entitlement.expiresAt ?? Number.POSITIVE_INFINITY;
    const expiresAt = Math.min(now + ttlSeconds * 1000, entitlementLimit);
    const claims: SessionClaims = { v: 1, iat: now, exp: expiresAt, edition: entitlement.edition };
    const value = this.encodeSession(claims, this.getSigningSecret()!);
    return {
      response: responseFor('AUTHENTICATED', entitlement, this.edition.requireCode, expiresAt),
      cookie: this.sessionCookie(value, expiresAt),
    };
  }

  private sessionCookie(value: string, expiresAt: number): string {
    const maxAge = Math.max(0, Math.floor((expiresAt - this.now()) / 1000));
    const attributes = [
      `${SESSION_COOKIE}=${value}`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      `Max-Age=${maxAge}`,
      `Expires=${new Date(expiresAt).toUTCString()}`,
    ];
    if (this.env.NODE_ENV === 'production') attributes.push('Secure');
    return attributes.join('; ');
  }

  clearCookie(): string {
    const attributes = [
      `${SESSION_COOKIE}=`,
      'HttpOnly',
      'SameSite=Strict',
      'Path=/',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ];
    if (this.env.NODE_ENV === 'production') attributes.push('Secure');
    return attributes.join('; ');
  }
}

const authStatusCode = (response: AuthStatusResponse): number => ({
  AUTHENTICATED: 200,
  AUTH_REQUIRED: 401,
  INVALID_CODE: 401,
  AUTH_NOT_CONFIGURED: 503,
  SESSION_EXPIRED: 401,
  ENTITLEMENT_EXPIRED: 403,
  RATE_LIMITED: 429,
  UNAUTHORIZED_REQUEST: 403,
  SERVER_UNAVAILABLE: 503,
})[response.status];

const writeAuthResponse = (
  response: ServerResponse,
  body: AuthStatusResponse,
  cookie?: string,
  statusOverride?: number,
): void => {
  response.statusCode = statusOverride ?? authStatusCode(body);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  if (cookie) response.setHeader('Set-Cookie', cookie);
  response.end(JSON.stringify(body));
};

const isSameOriginRequest = (request: IncomingMessage): boolean => {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    const expectedProtocol = forwardedProto || ((request.socket as TLSSocket).encrypted ? 'https' : 'http');
    return originUrl.host === request.headers.host && originUrl.protocol === `${expectedProtocol}:`;
  } catch {
    return false;
  }
};

const readLoginCode = async (request: IncomingMessage): Promise<string> => {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_AUTH_BODY_BYTES) throw new Error('INVALID_BODY');
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || Object.keys(value).some(key => key !== 'code')
      || typeof (value as { code?: unknown }).code !== 'string'
      || (value as { code: string }).code.length > MAX_ACCESS_CODE_LENGTH
    ) throw new Error('INVALID_BODY');
    return (value as { code: string }).code;
  } catch {
    throw new Error('INVALID_BODY');
  }
};

export const isAuthPath = (pathname: string): boolean =>
  pathname === AUTH_LOGIN_PATH || pathname === AUTH_STATUS_PATH || pathname === AUTH_LOGOUT_PATH;

export function createAuthRequestHandler(authority: AuthSessionAuthority) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const pathname = (request.url || '').split('?')[0];
    const entitlement = authority.getEntitlement();
    const rejected = () => responseFor('UNAUTHORIZED_REQUEST', entitlement, authority.requiresCode());

    if (!isSameOriginRequest(request)) return writeAuthResponse(response, rejected());

    if (pathname === AUTH_STATUS_PATH) {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        return writeAuthResponse(response, rejected());
      }
      const inspection = authority.inspect(request).response;
      const normalStatus = ['AUTH_REQUIRED', 'SESSION_EXPIRED'].includes(inspection.status) ? 200 : undefined;
      return writeAuthResponse(response, inspection, undefined, normalStatus);
    }

    if (pathname === AUTH_LOGOUT_PATH) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return writeAuthResponse(response, rejected());
      }
      return writeAuthResponse(
        response,
        responseFor('AUTH_REQUIRED', entitlement, authority.requiresCode()),
        authority.clearCookie(),
        200,
      );
    }

    if (pathname === AUTH_LOGIN_PATH) {
      if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return writeAuthResponse(response, rejected());
      }
      try {
        const result = authority.login(request, await readLoginCode(request));
        return writeAuthResponse(response, result.response, result.cookie);
      } catch {
        return writeAuthResponse(response, rejected());
      }
    }

    return writeAuthResponse(response, rejected());
  };
}

export function authSessionPlugin(authority: AuthSessionAuthority): Plugin {
  const handleRequest = createAuthRequestHandler(authority);
  const install = (middlewares: { use: (fn: (request: IncomingMessage, response: ServerResponse, next: () => void) => void) => void }) => {
    middlewares.use(async (request, response, next) => {
      const pathname = (request.url || '').split('?')[0];
      if (!isAuthPath(pathname)) return next();
      await handleRequest(request, response);
    });
  };
  return {
    name: 'auth-session-authority',
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
  };
}
