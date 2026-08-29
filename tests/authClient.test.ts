import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatusResponse } from '../shared/authContract';
import {
  getAuthStatus,
  loginWithAccessCode,
} from '../src/services/api/authClient';

const authRequiredResponse: AuthStatusResponse = {
  authenticated: false,
  status: 'AUTH_REQUIRED',
  message: 'Authentication required.',
  requiresCode: true,
  entitlement: {
    edition: 'full',
    label: '6 Tháng',
    valid: true,
    expiresAt: null,
    policy: 'full-expiry',
  },
};

const jsonResponse = (payload: unknown): Response => new Response(JSON.stringify(payload), {
  status: 200,
  headers: { 'Content-Type': 'application/json; charset=utf-8' },
});

const startingServerResponse = (): Response => new Response(
  '<!doctype html><title>Starting Server...</title>',
  { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
);

describe('auth client cold-start handling', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('retries status checks when AI Studio temporarily returns infrastructure HTML', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(startingServerResponse())
      .mockResolvedValueOnce(jsonResponse(authRequiredResponse));
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAuthStatus({ retryDelaysMs: [0, 0] });

    expect(result).toEqual(authRequiredResponse);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails closed after all status retry attempts return non-app responses', async () => {
    const fetchMock = vi.fn().mockResolvedValue(startingServerResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await getAuthStatus({ retryDelaysMs: [0, 0, 0] });

    expect(result.status).toBe('SERVER_UNAVAILABLE');
    expect(result.authenticated).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not replay login requests when a response is not app JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(startingServerResponse());
    vi.stubGlobal('fetch', fetchMock);

    const result = await loginWithAccessCode('owner-code');

    expect(result.status).toBe('SERVER_UNAVAILABLE');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
