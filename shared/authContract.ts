import type { EntitlementDecision } from './editionContract';

export const AUTH_LOGIN_PATH = '/api/auth/login';
export const AUTH_STATUS_PATH = '/api/auth/status';
export const AUTH_LOGOUT_PATH = '/api/auth/logout';

export type AuthStatusCode =
  | 'AUTHENTICATED'
  | 'AUTH_REQUIRED'
  | 'INVALID_CODE'
  | 'AUTH_NOT_CONFIGURED'
  | 'SESSION_EXPIRED'
  | 'ENTITLEMENT_EXPIRED'
  | 'RATE_LIMITED'
  | 'UNAUTHORIZED_REQUEST'
  | 'SERVER_UNAVAILABLE';

export type PublicEntitlement = EntitlementDecision;

export interface AuthStatusResponse {
  authenticated: boolean;
  status: AuthStatusCode;
  message: string;
  requiresCode: boolean;
  entitlement: PublicEntitlement;
  sessionExpiresAt?: number;
}
