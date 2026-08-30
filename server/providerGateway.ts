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
import { GeminiScheduler, isPrivateAiStudio, isSafeProfileLabel, isSameOriginBrowserRequest } from './geminiScheduler';
import { supportsGeminiSamplingConfig } from '../shared/geminiModelRegistry';

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
  scheduler?: GeminiScheduler;
}

export type ProviderHttpHandlerOptions = ProviderGatewayDependencies;

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
    const exhausted = /quota_exceeded|daily|per day|daily quota/.test(lower);
    return new GatewayFailure(429, exhausted ? 'QUOTA_EXHAUSTED' : 'RATE_LIMITED', exhausted ? 'Hạn mức ngày của model đã hết; hãy chờ nhà cung cấp đặt lại.' : 'Model đang trong thời gian chờ do giới hạn tốc độ.', true);
  }
  if (status === 401 || status === 403) {
    return new GatewayFailure(status, 'PROFILE_MISCONFIGURED', 'Gemini profile credential or project access is not configured correctly.', true);
  }
  if (status === 404 || /model.*(?:not found|unsupported|unavailable)/.test(lower)) {
    return new GatewayFailure(status || 404, 'MODEL_UNAVAILABLE', 'The selected model is unavailable on this Gemini profile.', true);
  }
  if (status === 503 || /provider.*unavailable|overload/.test(lower)) {
    return new GatewayFailure(status || 503, 'PROVIDER_UNAVAILABLE', 'The provider is temporarily unavailable.', true);
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
  if (Object.keys(payload.request).some(key => !['model', 'modelCandidates', 'contents', 'config'].includes(key))) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini request contains an unsupported field.');
  }
  if (payload.request.contents === undefined || !isPlainJson(payload.request.contents)) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini contents must be valid JSON.');
  }
  if (payload.request.modelCandidates !== undefined && (!Array.isArray(payload.request.modelCandidates)
    || payload.request.modelCandidates.length < 1 || payload.request.modelCandidates.length > 8
    || payload.request.modelCandidates.some(model => typeof model !== 'string' || !APPROVED_GEMINI_MODELS.includes(model as any)))) {
    throw new GatewayFailure(400, 'INVALID_REQUEST', 'Gemini model candidates are invalid.');
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

function serializeGeminiResponse(
  response: any,
  target?: { profile: { id: string; label: string; fingerprint: string }; model: string },
  preferredModel?: string,
): GeminiGatewayResponse {
  return {
    text: response?.text,
    data: response?.data,
    candidates: response?.candidates,
    modelVersion: response?.modelVersion,
    promptFeedback: response?.promptFeedback,
    responseId: response?.responseId,
    usageMetadata: response?.usageMetadata,
    ...(target ? { executionTarget: {
      profileId: target.profile.id,
      profileLabel: target.profile.label,
      profileFingerprint: target.profile.fingerprint,
      model: target.model,
      ...(preferredModel && preferredModel !== target.model ? { fallbackFrom: preferredModel } : {}),
    } } : {}),
  };
}

function geminiConfigForModel(config: Record<string, unknown> | undefined, model: string, signal?: AbortSignal): Record<string, unknown> {
  const sanitized = { ...(config || {}) };
  if (!supportsGeminiSamplingConfig(model)) {
    delete sanitized.temperature;
    delete sanitized.topP;
    delete sanitized.topK;
    delete sanitized.candidateCount;
  }
  if (signal) sanitized.abortSignal = signal;
  return sanitized;
}

async function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function createGeminiStream(
  candidates: readonly string[], dependencies: Required<ProviderGatewayDependencies>,
  request: GeminiGatewayRequest['request'], signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const { modelCandidates: _modelCandidates, ...providerRequest } = request;
  void _modelCandidates;
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const tried = new Set<string>();
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !signal?.aborted) {
        const lease = dependencies.scheduler.acquire(candidates, tried);
        if (!lease) {
          const delay = dependencies.scheduler.nextRetryDelay(candidates, deadline - Date.now());
          if (!delay) break;
          try {
            await waitForRetry(delay, signal);
          } catch (error) {
            const failure = normalizedFailure(error, signal);
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', error: { code: failure.code, message: failure.message, retryable: failure.retryable } })}\n`));
            controller.close();
            return;
          }
          tried.clear();
          continue;
        }
        tried.add(`${lease.profile.id}\u0000${lease.model}`);
        let emitted = false;
        try {
          const client = dependencies.createGeminiClient(lease.profile.key);
          const stream = await client.models.generateContentStream({
            ...providerRequest, model: lease.model,
            config: geminiConfigForModel(request.config, lease.model, signal),
          });
          for await (const chunk of stream) {
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            emitted = true;
            controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'chunk', data: serializeGeminiResponse(chunk, lease, candidates[0]) })}\n`));
          }
          dependencies.scheduler.complete(lease);
          controller.close();
          return;
        } catch (error) {
          const targetStatus = dependencies.scheduler.complete(lease, error);
          const failure = normalizedFailure(error, signal);
          const canFailOver = failure.retryable || targetStatus === 'MISCONFIGURED';
          if (!emitted && canFailOver && failure.code !== 'ABORTED') continue;
          controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', error: { code: failure.code, message: failure.message, retryable: failure.retryable } })}\n`));
          controller.close();
          return;
        }
      }
      const failure = signal?.aborted ? normalizedFailure(new DOMException('Aborted', 'AbortError'), signal)
        : new GatewayFailure(503, 'PROFILE_UNAVAILABLE', 'Không có profile/model Gemini khả dụng.', true);
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', error: { code: failure.code, message: failure.message, retryable: failure.retryable } })}\n`));
      controller.close();
    },
  });
}

async function executeGemini(
  payload: GeminiGatewayRequest,
  dependencies: Required<ProviderGatewayDependencies>,
  signal?: AbortSignal,
  deadline = Date.now() + 60_000,
): Promise<Response> {
  validateGemini(payload);
  const scheduler = dependencies.scheduler;
  const candidates = [...new Set(payload.request.modelCandidates?.length ? payload.request.modelCandidates : [payload.request.model])];
  const { modelCandidates: _modelCandidates, ...providerRequest } = payload.request;
  void _modelCandidates;
  if (!scheduler.getProfiles().length) {
    throw new GatewayFailure(503, 'SERVER_CONFIGURATION_MISSING', 'Gemini chưa được cấu hình trên máy chủ. Thêm GEMINI_API_KEY trong AI Studio Settings > Secrets.');
  }
  if (payload.action === 'stream') {
    return new Response(createGeminiStream(candidates, dependencies, payload.request, signal), {
      headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const lease = scheduler.acquire(candidates);
  if (!lease) {
    const configured = scheduler.getProfiles().length > 0;
    if (!configured) {
    throw new GatewayFailure(503, 'SERVER_CONFIGURATION_MISSING', 'Gemini is not configured on the server. Add GEMINI_API_KEY in AI Studio Settings > Secrets.');
    }
    const delay = scheduler.nextRetryDelay(candidates, deadline - Date.now());
    if (delay) {
      await waitForRetry(delay, signal);
      return executeGemini(payload, dependencies, signal, deadline);
    }
    throw new GatewayFailure(503, 'PROFILE_UNAVAILABLE', 'Không có Gemini profile/model khả dụng; kiểm tra trạng thái profile hoặc thử lại sau.');
  }
  const client = dependencies.createGeminiClient(lease.profile.key);
  try {
    const response = await client.models.generateContent({
      ...providerRequest, model: lease.model,
      config: geminiConfigForModel(payload.request.config, lease.model, signal),
    });
    scheduler.complete(lease);
    return jsonResponse(serializeGeminiResponse(response, lease, candidates[0]));
  } catch (error) {
    const targetStatus = scheduler.complete(lease, error);
    const failure = normalizedFailure(error, signal);
    const canFailOver = failure.retryable || targetStatus === 'MISCONFIGURED';
    if (canFailOver && failure.code !== 'ABORTED' && scheduler.hasReady(candidates)) {
      // Scheduler state makes the next invocation select another ready profile
      // for this model before moving to a lower-priority candidate.
      return executeGemini(payload, dependencies, signal, deadline);
    }
    const delay = canFailOver ? scheduler.nextRetryDelay(candidates, deadline - Date.now()) : undefined;
    if (delay) {
      await waitForRetry(delay, signal);
      return executeGemini(payload, dependencies, signal, deadline);
    }
    throw error;
  }
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
    scheduler: dependencies.scheduler || new GeminiScheduler(dependencies.env || process.env),
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
  const providerDependencies: ProviderHttpHandlerOptions = {
    ...options,
    scheduler: options.scheduler || new GeminiScheduler(options.env || process.env),
  };

  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      await writeNodeResponse(errorResponse(new GatewayFailure(405, 'INVALID_REQUEST', 'Only POST is allowed.')), response);
      return;
    }

    const env = providerDependencies.env || process.env;
    if (!isPrivateAiStudio(env)) {
      await writeNodeResponse(errorResponse(new GatewayFailure(503, 'DEPLOYMENT_ACCESS_NOT_CONFIGURED', 'Provider credentials are disabled: set APP_DEPLOYMENT_MODE=private-aistudio only for a privately shared AI Studio deployment. Public deployments require real authentication and rate limits.')), response);
      return;
    }
    if (!isSameOriginBrowserRequest(request)) {
      await writeNodeResponse(errorResponse(new GatewayFailure(401, 'UNAUTHORIZED', 'Provider requests must originate from this private AI Studio application.')), response);
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

export function providerGatewayPlugin(options: ProviderHttpHandlerOptions = {}): Plugin {
  const handleRequest = createProviderRequestHandler(options);
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

/** Safe metadata only: credentials are discovered from process env and are never writable through HTTP. */
export function createGeminiProfilesRequestHandler(options: ProviderGatewayDependencies = {}) {
  const scheduler = options.scheduler || new GeminiScheduler(options.env || process.env);
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const env = options.env || process.env;
    if (!isPrivateAiStudio(env) || !isSameOriginBrowserRequest(request)) {
      await writeNodeResponse(errorResponse(new GatewayFailure(503, 'DEPLOYMENT_ACCESS_NOT_CONFIGURED', 'Gemini profile metadata is available only in private AI Studio mode.')), response); return;
    }
    const pathname = (request.url || '').split('?')[0];
    if (request.method === 'GET' && pathname === '/api/provider/profiles') { await writeNodeResponse(jsonResponse({ profiles: scheduler.getProfiles() }), response); return; }
    if (request.method !== 'POST') { response.setHeader('Allow', 'GET, POST'); await writeNodeResponse(errorResponse(new GatewayFailure(405, 'INVALID_REQUEST', 'Only GET and POST are allowed.')), response); return; }
    try {
      const input = await readJsonBody(request) as { action?: string; profileId?: string; label?: string; disabled?: boolean; model?: string; enabled?: boolean };
      if (!input || typeof input !== 'object' || typeof input.action !== 'string') throw new GatewayFailure(400, 'INVALID_REQUEST', 'Profile action is malformed.');
      if (input.action === 'add') {
        // Secrets are process-owned. "Add" only tells the operator the next
        // numbered AI Studio secret; a reload discovers it without ever POSTing a key.
      } else if (typeof input.profileId !== 'string') throw new GatewayFailure(400, 'INVALID_REQUEST', 'Profile identifier is required.');
      else if (input.action === 'update') {
        if (typeof input.label === 'string' && !isSafeProfileLabel(input.label)) {
          throw new GatewayFailure(400, 'INVALID_REQUEST', 'A profile label must not contain credential material.');
        }
        const profile = scheduler.updateProfile(input.profileId, { label: input.label, disabled: input.disabled });
        if (!profile) throw new GatewayFailure(404, 'INVALID_REQUEST', 'Profile was not found.');
      } else if (input.action === 'model' && typeof input.model === 'string' && typeof input.enabled === 'boolean') {
        if (!scheduler.setModelEnabled(input.profileId, input.model, input.enabled)) throw new GatewayFailure(404, 'INVALID_REQUEST', 'Profile or model was not found.');
      } else if (input.action === 'remove') {
        const profile = scheduler.updateProfile(input.profileId, { disabled: true });
        if (!profile) throw new GatewayFailure(404, 'INVALID_REQUEST', 'Profile was not found.');
      } else if (input.action === 'test') {
        const model = typeof input.model === 'string' && APPROVED_GEMINI_MODELS.includes(input.model as any)
          ? input.model : APPROVED_GEMINI_MODELS[0];
        const lease = scheduler.acquireForProfile(input.profileId, model);
        if (!lease) throw new GatewayFailure(503, 'PROFILE_UNAVAILABLE', 'Không có profile/model Gemini khả dụng để kiểm tra.', true);
        try {
          await (options.createGeminiClient || ((apiKey: string) => new GoogleGenAI({ apiKey }) as unknown as GeminiClient))(lease.profile.key)
            .models.generateContent({ model: lease.model, contents: 'Trả lời đúng một từ: OK.', config: { maxOutputTokens: 8 } });
          scheduler.complete(lease);
        } catch (error) { scheduler.complete(lease, error); throw error; }
      } else throw new GatewayFailure(400, 'INVALID_REQUEST', 'Unsupported profile action.');
      await writeNodeResponse(jsonResponse({ profiles: scheduler.getProfiles(), addSecretName: scheduler.nextProfileSecretName() }), response);
    } catch (error) { await writeNodeResponse(errorResponse(error), response); }
  };
}
