import {
  PROVIDER_GATEWAY_PATH,
  type DeepSeekGatewayRequest,
  type GeminiGatewayRequest,
  type GeminiGatewayResponse,
  type ProviderErrorCode,
  type ProviderErrorPayload,
  type ProviderGatewayRequest,
  type ProviderStreamEnvelope,
} from '../../../shared/providerContract';

export class ProviderGatewayError extends Error {
  constructor(
    message: string,
    readonly code: ProviderErrorCode,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ProviderGatewayError';
  }
}

async function throwGatewayError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as ProviderErrorPayload | null;
  throw new ProviderGatewayError(
    body?.error?.message || `Provider gateway failed with HTTP ${response.status}.`,
    body?.error?.code || 'PROVIDER_ERROR',
    response.status,
    body?.error?.retryable ?? response.status >= 500,
  );
}

async function ensureJsonResponse(response: Response): Promise<void> {
  const contentType = response.headers.get('content-type') || '';
  if (contentType.toLowerCase().includes('text/html')) {
    throw new ProviderGatewayError(
      'The AI Studio runtime is still starting. Please retry after the server is ready.',
      'PROVIDER_UNAVAILABLE',
      503,
      true,
    );
  }
}

export async function callProviderGateway<T>(payload: ProviderGatewayRequest, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(PROVIDER_GATEWAY_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error: any) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new ProviderGatewayError('Provider request was aborted.', 'ABORTED', 499, false);
    }
    throw new ProviderGatewayError('Cannot reach the same-origin provider gateway.', 'PROVIDER_UNAVAILABLE', 503, true);
  }
  if (!response.ok) return throwGatewayError(response);
  await ensureJsonResponse(response);
  return response.json() as Promise<T>;
}

export async function openProviderGatewayStream(payload: ProviderGatewayRequest, signal?: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(PROVIDER_GATEWAY_PATH, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error: any) {
    if (signal?.aborted || error?.name === 'AbortError') {
      throw new ProviderGatewayError('Provider request was aborted.', 'ABORTED', 499, false);
    }
    throw new ProviderGatewayError('Cannot reach the same-origin provider gateway.', 'PROVIDER_UNAVAILABLE', 503, true);
  }
  if (!response.ok) return throwGatewayError(response);
  await ensureJsonResponse(response);
  if (!response.body) throw new ProviderGatewayError('Provider stream has no response body.', 'PROVIDER_UNAVAILABLE', 502, true);
  return response;
}

export interface GeminiClientRequest {
  model: string;
  modelCandidates?: string[];
  contents: unknown;
  config?: Record<string, unknown> & { abortSignal?: AbortSignal };
}

function splitSignal(request: GeminiClientRequest): { signal?: AbortSignal; payload: GeminiGatewayRequest['request'] } {
  const { abortSignal, ...config } = request.config || {};
  return {
    signal: abortSignal,
    payload: { model: request.model, ...(request.modelCandidates?.length ? { modelCandidates: request.modelCandidates } : {}), contents: request.contents, ...(Object.keys(config).length ? { config } : {}) },
  };
}

export async function generateGeminiContent(request: GeminiClientRequest): Promise<GeminiGatewayResponse> {
  const { signal, payload } = splitSignal(request);
  return callProviderGateway<GeminiGatewayResponse>({ provider: 'gemini', action: 'generate', request: payload }, signal);
}

async function* readGeminiNdjson(response: Response, abortController: AbortController): AsyncGenerator<GeminiGatewayResponse> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          const envelope = JSON.parse(line) as ProviderStreamEnvelope;
          if (envelope.type === 'error') {
            const status = envelope.error.code === 'ABORTED' ? 499
              : envelope.error.code === 'RATE_LIMITED' || envelope.error.code === 'QUOTA_EXHAUSTED' ? 429
                : envelope.error.code === 'PROFILE_MISCONFIGURED' ? 401
                  : envelope.error.code === 'MODEL_UNAVAILABLE' ? 404
                    : envelope.error.code === 'SERVER_CONFIGURATION_MISSING' || envelope.error.code === 'PROVIDER_UNAVAILABLE'
                      || envelope.error.code === 'PROFILE_UNAVAILABLE' || envelope.error.code === 'TEMPORARILY_UNAVAILABLE' ? 503
                      : envelope.error.code === 'INVALID_REQUEST' || envelope.error.code === 'MODEL_NOT_ALLOWED' ? 400
                        : 502;
            throw new ProviderGatewayError(envelope.error.message, envelope.error.code, status, envelope.error.retryable);
          }
          yield envelope.data;
        }
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
  } catch (error) {
    if (error instanceof ProviderGatewayError) throw error;
    if (abortController.signal.aborted || (error as { name?: string })?.name === 'AbortError') {
      throw new ProviderGatewayError('Provider stream was aborted.', 'ABORTED', 499, false);
    }
    throw new ProviderGatewayError('Provider stream was interrupted before completion.', 'PROVIDER_UNAVAILABLE', 503, true);
  } finally {
    abortController.abort();
    try { await reader.cancel(); } catch { /* response may already be closed */ }
  }
}

export async function generateGeminiContentStream(request: GeminiClientRequest): Promise<AsyncGenerator<GeminiGatewayResponse>> {
  const { signal: callerSignal, payload } = splitSignal(request);
  const controller = new AbortController();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const response = await openProviderGatewayStream({ provider: 'gemini', action: 'stream', request: payload }, controller.signal);
  return readGeminiNdjson(response, controller);
}

/**
 * Collect one logical Gemini stream. If a retryable stream dies after emitting
 * partial text, that partial buffer is discarded and the entire logical call
 * restarts. This is required for canon-safe long-form Story Engine output: two
 * different profile/model continuations are never concatenated.
 */
export async function generateGeminiContentStreamWithRestart(
  request: GeminiClientRequest,
  options: {
    maxAttempts?: number;
    onExecutionTarget?: (target: NonNullable<GeminiGatewayResponse['executionTarget']>) => void;
    onRestart?: (attempt: number, error: ProviderGatewayError) => void;
  } = {},
): Promise<GeminiGatewayResponse> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? 2, 3));
  let finalError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let text = '';
    let aggregate: GeminiGatewayResponse = {};
    let targetReported = false;
    try {
      const stream = await generateGeminiContentStream(request);
      for await (const chunk of stream) {
        text += chunk.text || '';
        aggregate = { ...aggregate, ...chunk };
        if (chunk.executionTarget && !targetReported) {
          targetReported = true;
          options.onExecutionTarget?.(chunk.executionTarget);
        }
      }
      return { ...aggregate, text };
    } catch (error) {
      finalError = error;
      const normalized = error instanceof ProviderGatewayError
        ? error
        : new ProviderGatewayError('Provider stream was interrupted before completion.', 'PROVIDER_UNAVAILABLE', 503, true);
      if (request.config?.abortSignal?.aborted || normalized.code === 'ABORTED' || !normalized.retryable || attempt >= maxAttempts) {
        throw normalized;
      }
      options.onRestart?.(attempt, normalized);
      // `text` is intentionally abandoned here. The scheduler will select a
      // fresh target for the next complete logical attempt.
    }
  }
  throw finalError instanceof Error ? finalError
    : new ProviderGatewayError('Provider stream failed safely.', 'PROVIDER_UNAVAILABLE', 503, true);
}

export const createGatewayGeminiClient = () => ({
  models: {
    generateContent: generateGeminiContent,
    generateContentStream: generateGeminiContentStream,
  },
});

export const callDeepSeekGateway = <T>(payload: DeepSeekGatewayRequest, signal?: AbortSignal) =>
  callProviderGateway<T>(payload, signal);

export const openDeepSeekGatewayStream = (payload: DeepSeekGatewayRequest, signal?: AbortSignal) =>
  openProviderGatewayStream(payload, signal);
