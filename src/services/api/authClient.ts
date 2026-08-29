import {
  AUTH_LOGIN_PATH,
  AUTH_LOGOUT_PATH,
  AUTH_STATUS_PATH,
  type AuthStatusResponse,
} from '../../../shared/authContract';
import { evaluateEditionEntitlement } from '../../../shared/editionContract';

const unavailableResponse = (): AuthStatusResponse => ({
  authenticated: false,
  status: 'SERVER_UNAVAILABLE',
  message: 'The authentication server is unavailable.',
  requiresCode: true,
  entitlement: evaluateEditionEntitlement(),
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
    return await response.json() as AuthStatusResponse;
  } catch {
    return unavailableResponse();
  }
}

export const getAuthStatus = (): Promise<AuthStatusResponse> => authRequest(AUTH_STATUS_PATH);

export const loginWithAccessCode = (code: string): Promise<AuthStatusResponse> => authRequest(AUTH_LOGIN_PATH, {
  method: 'POST',
  body: JSON.stringify({ code }),
});

export const logoutServerSession = (): Promise<AuthStatusResponse> => authRequest(AUTH_LOGOUT_PATH, {
  method: 'POST',
});
