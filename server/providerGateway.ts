import { GoogleGenAI } from '@google/genai';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  APPROVED_DEEPSEEK_MODELS,
  APPROVED_GEMINI_MODELS,
  PROVIDER_GATEWAY_PATH,
  type DeepSeekGatewayRequest,
  type GeminiGatewayRequest,
  type GeminiGatewayResponse,
  type ProviderErrorCode,
  type ProviderErrorPayload,
  type ProviderGatewayRequest,
} from '../shared/providerContract';
import { redactProviderSecrets } from '../src/utils/secretRedaction';

const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';
const GEMINI_CONFIG_FIELDS = new Set([
  'systemInstruction', 'temperature', 'topP', 'topK', 'candidateCount',
  'maxOutputTokens', 'stopSequences', 'responseLogprobs', 'logprobs',
  'presencePenalty', 'frequencyPenalty', 'seed', 'responseMimeType',
  'responseSchema', 'responseJsonSchema', 'safetySettings', 'tools',
  'toolConfig', 'responseModalities', 'mediaResolution', 'thinkingConfig',
  'imageConfig', 'enableEnhancedCivicAnswers',
]);
const DEEPSEEK_REQUEST_FIELDS = new Set([
  'model', 'messages', 'temperature', 'max_tokens', 'response_format', 'thinking',
]);

type GeminiClient = {
  models: {
    generateContent(params: Record<string, unknown>): Promise<any>;
    generateContentStream(params: Record<string, unknown>): Promise<AsyncIterable<any>>;
  };
};

export interface ProviderGatewayDependencies {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  createGeminiClient?: (apiKey: string) => GeminiClient;
}

export type ProviderRequestAuthorizer = (request: IncomingMessage) => boolean | Promise<boolean>;

export interface ProviderHttpHandlerOptions extends ProviderGatewayDependencies {
  /**
   * Must be supplied by the server-side access/session authority owned by WP-FIN-03.
   * There is deliberately no browser token or header fallback.
   */
  authorizeRequest?: ProviderRequestAuthorizer;
}

class GatewayFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: ProviderErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function normalizedFailure(error: unknown, signal?: AbortSignal): GatewayFailure {
  if (error instanceof GatewayFailure) return error;
  const raw = error as { status?: number; statusCode?: number; code?: string; name?: string; message?: string };
  const status = Number(raw?.status || raw?.statusCode || 0);
  const message = redactProviderSecrets(raw?.message || String(error || 'Provider request failed.'));
  const lower = message.toLowerCase();

  if (signal?.aborted || raw?.name === 'AbortError' || raw?.code === 'ABORT_ERR' || lower === 'aborted') {
    return new GatewayFailure(499, 'ABORTED', 'Provider request was aborted.', false);
  }
  if (status === 429 || /quota|rate.?limit|resource.?exhausted|too many requests/.test(lower)) {
    return new GatewayFailure(429, 'RATE_LIMITED', 'Provider quota or rate limit was reached.', true);
  }
  if (status === 404 || status === 503 || /model.*(?:not found|unavailable)|provider.*unavailable/.test(lower)) {
    return new GatewayFailure(status || 503, 'PROVIDER_UNAVAILABLE', 'The selected provider or model is unavailable.', true);
  }
  if (status >= 400 && status < 500) {
    return new GatewayFailure(status, 'INVALID_REQUEST', 'The provider rejected the request.', false);
  }
  return new GatewayFailure(status >= 500 ? status : 502, 'PROVIDER_ERROR', 'The provider request failed safely.', status >= 500 || status === 0);
}

function errorResponse(error: unknown, signal?: AbortSignal): Response {
  const failure = normalizedFailure(error, signal);
  const body: ProviderErrorPayload = {
    error: { code: failure.code, message: failure.message, retryable: failure.retryable },
  };
  return jsonResponse(body, failure.status);
}

function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 30) return false;
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.length <= 100_000 && value.every(item => isPlainJson(item, depth + 1));
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  return !Object.keys(object).some(key => ['__proto__', 'prototype', 'constructor'].includes(key))
    && Object.values(object).every(child => isPlainJson(child, depth + 1));
}

function validateGemini(payload: GeminiGatewayRequest): void {
  if (Object.keys(payload).some(key => !['provider', 'action', 'request'].includes(key))) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini request contains an unsupported field.');
  }
  if (!['generate', 'stream', 'health'].includes(payload.action)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Unsupported Gemini action.');
  }
  if (!payload.request || !APPROVED_GEMINI_MODELS.includes(payload.request.model as any)) {
    throw new GatewayFailure(403, 'MODEL_NOT_ALLOWED', 'The requested Gemini model is not approved.');
  }
  if (Object.keys(payload.request).some(key => !['model', 'contents', 'config'].includes(key))) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini request contains an unsupported field.');
  }
  if (payload.request.contents === undefined || !isPlainJson(payload.request.contents)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini contents must be valid JSON.');
  }
  const config = payload.request.config;
  if (config !== undefined) {
    if (!isPlainJson(config) || Object.keys(config).some(key => !GEMINI_CONFIG_FIELDS.has(key))) {
      throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini generation config contains an unsupported field.');
    }
  }
}

function validateDeepSeek(payload: DeepSeekGatewayRequest): void {
  if (Object.keys(payload).some(key => !['provider', 'action', 'request', 'byokKey'].includes(key))) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek request contains an unsupported field.');
  }
  if (!['chat', 'stream', 'health'].includes(payload.action)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Unsupported DeepSeek action.');
  }
  const request = payload.request;
  if (!request || !APPROVED_DEEPSEEK_MODELS.includes(request.model as any)) {
    throw new GatewayFailure(403, 'MODEL_NOT_ALLOWED', 'The requested DeepSeek model is not approved.');
  }
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > 100) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek messages are malformed.');
  }
  if (Object.keys(request).some(key => !DEEPSEEK_REQUEST_FIELDS.has(key))) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek request contains an unsupported field.');
  }
  if (request.temperature !== undefined && (!Number.isFinite(request.temperature) || request.temperature < 0 || request.temperature > 2)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek temperature is invalid.');
  }
  if (request.max_tokens !== undefined && (!Number.isInteger(request.max_tokens) || request.max_tokens < 1 || request.max_tokens > 384_000)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek max_tokens is invalid.');
  }
  if (request.response_format !== undefined && request.response_format?.type !== 'json_object') {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek response_format is invalid.');
  }
  if (request.thinking !== undefined && request.thinking?.type !== 'disabled') {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek thinking config is invalid.');
  }
  for (const message of request.messages) {
    if (!message || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string') {
      throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek messages are malformed.');
    }
  }
  if (payload.byokKey !== undefined && (typeof payload.byokKey !== 'string' || payload.byokKey.length > 512)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'DeepSeek BYOK credential is malformed.');
  }
}

function serializeGeminiResponse(response: any): GeminiGatewayResponse {
  return {
    text: response?.text,
    data: response?.data,
    candidates: response?.candidates,
    modelVersion: response?.modelVersion,
    promptFeedback: response?.promptFeedback,
    responseId: response?.responseId,
    usageMetadata: response?.usageMetadata,
  };
}

function createGeminiStream(
  client: GeminiClient,
  request: GeminiGatewayRequest['request'],
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const stream = await client.models.generateContentStream({
          ...request,
          config: { ...(request.config || {}), ...(signal ? { abortSignal: signal } : {}) },
        });
        for await (const chunk of stream) {
          if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'chunk', data: serializeGeminiResponse(chunk) })}\n`));
        }
        controller.close();
      } catch (error) {
        const failure = normalizedFailure(error, signal);
        controller.enqueue(encoder.encode(`${JSON.stringify({
          type: 'error',
          error: { code: failure.code, message: failure.message, retryable: failure.retryable },
        })}\n`));
        controller.close();
      }
    },
  });
}

async function executeGemini(
  payload: GeminiGatewayRequest,
  dependencies: Required<ProviderGatewayDependencies>,
  signal?: AbortSignal,
): Promise<Response> {
  validateGemini(payload);
  const apiKey = dependencies.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new GatewayFailure(503, 'SERVER_CONFIGURATION_MISSING', 'Gemini is not configured on the server. Add GEMINI_API_KEY in AI Studio Settings > Secrets.');
  }
  const client = dependencies.createGeminiClient(apiKey);
  if (payload.action === 'stream') {
    return new Response(createGeminiStream(client, payload.request, signal), {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const response = await client.models.generateContent({
    ...payload.request,
    config: { ...(payload.request.config || {}), ...(signal ? { abortSignal: signal } : {}) },
  });
  return jsonResponse(serializeGeminiResponse(response));
}

async function executeDeepSeek(
  payload: DeepSeekGatewayRequest,
  dependencies: Required<ProviderGatewayDependencies>,
  signal?: AbortSignal,
): Promise<Response> {
  validateDeepSeek(payload);
  const apiKey = dependencies.env.DEEPSEEK_API_KEY?.trim() || payload.byokKey?.trim();
  if (!apiKey) {
    throw new GatewayFailure(503, 'SERVER_CONFIGURATION_MISSING', 'DeepSeek is not configured. Add DEEPSEEK_API_KEY to server Secrets or enter a session-only BYOK key.');
  }
  const upstream = await dependencies.fetchImpl(DEEPSEEK_API_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload.request, stream: payload.action === 'stream' }),
    signal,
  });
  if (!upstream.ok) {
    const providerBody = await upstream.json().catch(() => ({})) as any;
    const providerError = new Error(redactProviderSecrets(providerBody?.error?.message || `DeepSeek HTTP ${upstream.status}`)) as Error & { status: number };
    providerError.status = upstream.status;
    throw providerError;
  }
  if (payload.action === 'stream') {
    return new Response(upstream.body, {
      headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return jsonResponse(await upstream.json());
}

export async function handleProviderGateway(
  input: unknown,
  dependencies: ProviderGatewayDependencies = {},
  signal?: AbortSignal,
): Promise<Response> {
  const deps: Required<ProviderGatewayDependencies> = {
    env: dependencies.env || process.env,
    fetchImpl: dependencies.fetchImpl || fetch,
    createGeminiClient: dependencies.createGeminiClient || ((apiKey: string) => new GoogleGenAI({ apiKey }) as unknown as GeminiClient),
  };
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new GatewayFailure(400, 'INVALID_REQUEST', 'Provider request must be a JSON object.');
    }
    const payload = input as ProviderGatewayRequest;
    if (payload.provider === 'gemini') return await executeGemini(payload, deps, signal);
    if (payload.provider === 'deepseek') return await executeDeepSeek(payload, deps, signal);
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Unsupported provider.');
  } catch (error) {
    return errorResponse(error, signal);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new GatewayFailure(413, 'INVALID_REQUEST', 'Provider request is too large.');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Provider request body is not valid JSON.');
  }
}

async function writeNodeResponse(webResponse: Response, response: ServerResponse): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  if (!webResponse.body) return void response.end();
  const reader = webResponse.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!response.write(Buffer.from(value))) await new Promise(resolve => response.once('drain', resolve));
    }
  } finally {
    response.end();
  }
}

export function createProviderRequestHandler(options: ProviderHttpHandlerOptions = {}) {
  const { authorizeRequest, ...providerDependencies } = options;

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      await writeNodeResponse(errorResponse(new GatewayFailure(405, 'INVALID_REQUEST', 'Only POST is allowed.')), response);
      return;
    }

    if (!authorizeRequest) {
      await writeNodeResponse(errorResponse(new GatewayFailure(
        503,
        'AUTHORIZATION_NOT_CONFIGURED',
        'Provider access is blocked until server-side session and entitlement enforcement is installed by WP-FIN-03.',
      )), response);
      return;
    }

    let authorized = false;
    try {
      authorized = await authorizeRequest(request);
    } catch {
      await writeNodeResponse(errorResponse(new GatewayFailure(
        503,
        'AUTHORIZATION_NOT_CONFIGURED',
        'Provider access authorization could not be verified.',
      )), response);
      return;
    }
    if (!authorized) {
      await writeNodeResponse(errorResponse(new GatewayFailure(401, 'UNAUTHORIZED', 'Provider access is not authorized.')), response);
      return;
    }

    const abortController = new AbortController();
    request.once('aborted', () => abortController.abort());
    response.once('close', () => { if (!response.writableEnded) abortController.abort(); });
    try {
      const input = await readJsonBody(request);
      await writeNodeResponse(
        await handleProviderGateway(input, providerDependencies, abortController.signal),
        response,
      );
    } catch (error) {
      await writeNodeResponse(errorResponse(error, abortController.signal), response);
    }
  };
}

export function providerGatewayPlugin(): Plugin {
  const handleRequest = createProviderRequestHandler();
  const install = (middlewares: { use: (fn: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, next: () => void) => void) => void }) => {
    middlewares.use(async (request, response, next) => {
      const pathname = (request.url || '').split('?')[0];
      if (pathname !== PROVIDER_GATEWAY_PATH) return next();
      await handleRequest(request, response);
    });
  };

  return {
    name: 'provider-gateway',
    configureServer(server) { install(server.middlewares); },
    configurePreviewServer(server) { install(server.middlewares); },
  };
}
