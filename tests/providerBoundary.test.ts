import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleProviderGateway } from '../server/providerGateway';
import { APPROVED_GEMINI_MODELS } from '../shared/providerContract';
import { MODEL_CONFIGS } from '../src/constants';
import { DEEPSEEK_MODELS } from '../src/services/api/deepseek';
import { APPROVED_DEEPSEEK_MODELS } from '../shared/providerContract';
import { sanitizePersistedCredentials } from '../src/utils/credentialSanitizer';
import { redactProviderSecrets } from '../src/utils/secretRedaction';
import { generateGeminiContentStream } from '../src/services/api/providerGatewayClient';

const GEMINI_MODEL = 'gemini-3.5-flash';
const geminiPayload = (action: 'generate' | 'stream' | 'health' = 'generate', model = GEMINI_MODEL) => ({
  provider: 'gemini' as const,
  action,
  request: { model, contents: 'Hello', config: { temperature: 0.2 } },
});

const readJson = async (response: Response) => response.json() as Promise<any>;

describe('WP-FIN-02 provider boundary', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads Gemini secret only on the server and never returns it', async () => {
    const sentinel = 'AIzaServerOnlySentinel_123456789012345';
    let receivedKey = '';
    const response = await handleProviderGateway(geminiPayload(), {
      env: { GEMINI_API_KEY: sentinel },
      createGeminiClient: key => {
        receivedKey = key;
        return { models: {
          generateContent: async () => ({ text: 'safe result', candidates: [{ finishReason: 'STOP' }] }),
          generateContentStream: async () => (async function* () {})(),
        } };
      },
    });
    const body = await readJson(response);
    expect(response.status).toBe(200);
    expect(receivedKey).toBe(sentinel);
    expect(body.text).toBe('safe result');
    expect(JSON.stringify(body)).not.toContain(sentinel);
    expect(JSON.stringify(geminiPayload())).not.toContain(sentinel);
  });

  it('reports a safe explicit missing-secret configuration error', async () => {
    const response = await handleProviderGateway(geminiPayload(), { env: {} });
    const body = await readJson(response);
    expect(response.status).toBe(503);
    expect(body.error.code).toBe('SERVER_CONFIGURATION_MISSING');
    expect(body.error.message).toContain('AI Studio Settings > Secrets');
  });

  it('normalizes quota failures without returning provider stacks or credentials', async () => {
    const secret = 'AIzaRateLimitSentinel_123456789012345';
    const response = await handleProviderGateway(geminiPayload(), {
      env: { GEMINI_API_KEY: secret },
      createGeminiClient: () => ({ models: {
        generateContent: async () => { throw Object.assign(new Error(`429 RESOURCE_EXHAUSTED ${secret}`), { status: 429 }); },
        generateContentStream: async () => (async function* () {})(),
      } }),
    });
    const body = await readJson(response);
    expect(response.status).toBe(429);
    expect(body.error).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain('at ');
  });

  it('streams normalized Gemini chunks and propagates cancellation', async () => {
    const abortController = new AbortController();
    let serverSignal: AbortSignal | undefined;
    const response = await handleProviderGateway(geminiPayload('stream'), {
      env: { GEMINI_API_KEY: 'server-test-key' },
      createGeminiClient: () => ({ models: {
        generateContent: async () => ({}),
        generateContentStream: async (params: any) => {
          serverSignal = params.config.abortSignal;
          return (async function* () {
            yield { text: 'first', candidates: [{ finishReason: undefined }] };
            await new Promise<void>(resolve => serverSignal!.addEventListener('abort', () => resolve(), { once: true }));
            throw new DOMException('Aborted', 'AbortError');
          })();
        },
      } }),
    }, abortController.signal);
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('"type":"chunk"');
    expect(first).toContain('first');
    abortController.abort();
    const second = new TextDecoder().decode((await reader.read()).value);
    expect(serverSignal?.aborted).toBe(true);
    expect(second).toContain('"code":"ABORTED"');
  });

  it('keeps the browser streaming adapter compatible with async iteration', async () => {
    const ndjson = [
      JSON.stringify({ type: 'chunk', data: { text: 'A', candidates: [{}] } }),
      JSON.stringify({ type: 'chunk', data: { text: 'B', candidates: [{ finishReason: 'STOP' }] } }),
    ].join('\n') + '\n';
    const fetchMock = vi.fn(async () => new Response(ndjson, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const stream = await generateGeminiContentStream({ model: GEMINI_MODEL, contents: 'Hello' });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks.map(chunk => chunk.text)).toEqual(['A', 'B']);
    expect(fetchMock).toHaveBeenCalledWith('/api/provider', expect.objectContaining({ method: 'POST' }));
    vi.unstubAllGlobals();
  });

  it('rejects malformed and unapproved role/model requests', async () => {
    const malformed = await handleProviderGateway({ provider: 'gemini', action: 'generate' }, { env: { GEMINI_API_KEY: 'x' } });
    const bypass = await handleProviderGateway(geminiPayload('generate', 'gemini-arbitrary-bypass'), { env: { GEMINI_API_KEY: 'x' } });
    expect((await readJson(malformed)).error.code).toBe('MODEL_NOT_ALLOWED');
    expect((await readJson(bypass)).error.code).toBe('MODEL_NOT_ALLOWED');
    expect(MODEL_CONFIGS.every(model => APPROVED_GEMINI_MODELS.includes(model.id as any))).toBe(true);
    expect(DEEPSEEK_MODELS.every(model => APPROVED_DEEPSEEK_MODELS.includes(model.id as any))).toBe(true);
  });

  it('prefers an owner DeepSeek secret and never returns either credential', async () => {
    const ownerSecret = 'sk-owner-secret-1234567890';
    const byokSecret = 'sk-byok-secret-1234567890';
    let authorization = '';
    const response = await handleProviderGateway({
      provider: 'deepseek',
      action: 'health',
      request: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 5 },
      byokKey: byokSecret,
    }, {
      env: { DEEPSEEK_API_KEY: ownerSecret },
      fetchImpl: vi.fn(async (_url, init) => {
        authorization = new Headers(init?.headers).get('Authorization') || '';
        return new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }), { status: 200 });
      }) as typeof fetch,
    });
    const bodyText = await response.text();
    expect(authorization).toBe(`Bearer ${ownerSecret}`);
    expect(bodyText).not.toContain(ownerSecret);
    expect(bodyText).not.toContain(byokSecret);
  });

  it('proxies DeepSeek SSE streaming through the same-origin contract', async () => {
    const upstreamSse = 'data: {"choices":[{"delta":{"content":"xin chào"}}]}\n\ndata: [DONE]\n\n';
    const response = await handleProviderGateway({
      provider: 'deepseek',
      action: 'stream',
      request: { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'Hi' }] },
    }, {
      env: { DEEPSEEK_API_KEY: 'sk-server-stream-secret-123456' },
      fetchImpl: vi.fn(async () => new Response(upstreamSse, { status: 200 })) as typeof fetch,
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(await response.text()).toBe(upstreamSse);
  });

  it('sanitizes legacy credentials recursively without damaging manuscript data', () => {
    const legacy = {
      deepseekKey: 'sk-legacy-secret-123456',
      files: [{ id: 'chapter-1', content: 'Ordinary manuscript prose with sk- as punctuation.' }],
      nested: { geminiApiKey: 'AIzaLegacySecret_123456789012345', setting: 42 },
    };
    const sanitized = sanitizePersistedCredentials(legacy);
    expect(sanitized.removed).toBe(2);
    expect(sanitized.value).toEqual({
      files: legacy.files,
      nested: { setting: 42 },
    });
  });

  it('serializes session and automatic-backup snapshots without provider keys', () => {
    const liveState = {
      files: [{ id: 'chapter-1', content: 'accepted manuscript' }],
      deepseekKey: 'sk-session-secret-1234567890',
      nested: { GEMINI_API_KEY: 'AIzaSnapshotSecret_123456789012345' },
    };
    const sessionJson = JSON.stringify(sanitizePersistedCredentials(liveState).value);
    const automaticBackupJson = JSON.stringify(sanitizePersistedCredentials(liveState).value);
    for (const serialized of [sessionJson, automaticBackupJson]) {
      expect(serialized).toContain('accepted manuscript');
      expect(serialized).not.toContain('sk-session-secret');
      expect(serialized).not.toContain('AIzaSnapshotSecret');
      expect(serialized).not.toContain('deepseekKey');
    }
  });

  it('keeps normal runtime free of durable DeepSeek key writes', async () => {
    const { readFile } = await import('node:fs/promises');
    const [coreState, storage] = await Promise.all([
      readFile(new URL('../src/hooks/useCoreState.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/utils/storage.ts', import.meta.url), 'utf8'),
    ]);
    expect(coreState).not.toContain("localStorage.setItem('app_deepseek_key'");
    expect(coreState).toContain("useState<string>('')");
    expect(storage).toContain('sanitizePersistedCredentials(data).value');
  });

  it('redacts credential-bearing thrown errors before durable logging', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) || null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    const { appendPersistedLog } = await import('../src/utils/logStore');
    const secret = 'sk-thrown-secret-1234567890';
    appendPersistedLog(`Provider failed Authorization: Bearer ${secret}`, 'error');
    const persisted = [...values.values()].join('\n');
    expect(persisted).toContain('[REDACTED');
    expect(persisted).not.toContain(secret);
    vi.unstubAllGlobals();
  });

  it('uses narrow redaction and leaves ordinary manuscript prose intact', () => {
    const prose = 'Nhân vật hỏi về chiếc bearer và chuỗi sk- ngắn trong bản thảo.';
    expect(redactProviderSecrets(prose)).toBe(prose);
    expect(redactProviderSecrets('GEMINI_API_KEY=AIzaSecretValue_123456789012345')).not.toContain('AIzaSecretValue');
  });
});
