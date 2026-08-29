import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_STATUS_PATH,
  type AuthStatusCode,
  type AuthStatusResponse,
} from '../../../shared/authContract';
import { evaluateEditionEntitlement } from '../../../shared/editionContract';

const AUTH_STATUS_CODES = new Set<AuthStatusCode>([
  'AUTHENTICATED',
  'AUTH_REQUIRED',
  'INVALID_CODE',
  'AUTH_NOT_CONFIGURED',
  'SESSION_EXPIRED',
  'ENTITLEMENT_EXPIRED',
  'RATE_LIMITED',
  'UNAUTHORIZED_REQUEST',
  'SERVER_UNAVAILABLE',
]);

const DEFAULT_STATUS_RETRY_DELAYS_MS = [0, 250, 500, 1_000, 2_000, 3_000] as const;

export interface AuthStatusCheckOptions {
  retryDelaysMs?: readonly number[];
}

const unavailableResponse = (): AuthStatusResponse => ({
  authenticated: false,
  status: 'SERVER_UNAVAILABLE',
  message: 'The authentication server is unavailable.',
  requiresCode: true,
  entitlement: evaluateEditionEntitlement(),
});

const isAuthStatusResponse = (value: unknown): value is AuthStatusResponse => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AuthStatusResponse>;
  return typeof candidate.authenticated === 'boolean'
    && typeof candidate.status === 'string'
    && AUTH_STATUS_CODES.has(candidate.status as AuthStatusCode)
    && typeof candidate.message === 'string'
    && typeof candidate.requiresCode === 'boolean'
    && !!candidate.entitlement
    && typeof candidate.entitlement === 'object';
};

const wait = (delayMs: number): Promise<void> => new Promise(resolve => {
  globalThis.setTimeout(resolve, Math.max(0, delayMs));
});

async function authRequest(path: string, init?: RequestInit): Promise<AuthStatusResponse> {
  try {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...init,
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init?.headers || {}),
      },
    });
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) return unavailableResponse();

    const payload: unknown = await response.json();
    return isAuthStatusResponse(payload) ? payload : unavailableResponse();
  } catch {
    return unavailableResponse();
  }
}

export const getAuthStatus = async (
  options: AuthStatusCheckOptions = {},
): Promise<AuthStatusResponse> => {
  const retryDelaysMs = options.retryDelaysMs?.length
    ? options.retryDelaysMs
    : DEFAULT_STATUS_RETRY_DELAYS_MS;
  let result = unavailableResponse();

  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await wait(delayMs);
    result = await authRequest(AUTH_STATUS_PATH);
    if (result.status !== 'SERVER_UNAVAILABLE') return result;
  }

  return result;
};

export const loginWithAccessCode = (code: string): Promise<AuthStatusResponse> => authRequest(AUTH_LOGIN_PATH, {
  method: 'POST',
  body: JSON.stringify({ code }),
});

export const logoutServerSession = (): Promise<AuthStatusResponse> => authRequest(AUTH_LOGOUT_PATH, {
  method: 'POST',
});
