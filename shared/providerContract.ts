import { APPROVED_GEMINI_MODEL_IDS, GEMINI_SPECIALIZED_MODELS } from './geminiModelRegistry';

export const PROVIDER_GATEWAY_PATH = '/api/provider';
export const GEMINI_PROFILES_PATH = '/api/provider/profiles';
export const GEMINI_PROFILE_ACTION_PATH = '/api/provider/profiles/';

/** Specialized IDs remain distinct in the registry, but are accepted by the gateway for their dedicated UI flows. */
export const APPROVED_GEMINI_MODELS = [...APPROVED_GEMINI_MODEL_IDS, ...GEMINI_SPECIALIZED_MODELS];

export const APPROVED_DEEPSEEK_MODELS = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
] as const;

export type ProviderErrorCode =
  | 'ABORTED'
  | 'DEPLOYMENT_ACCESS_NOT_CONFIGURED'
  | 'PROFILE_UNAVAILABLE'
  | 'PROFILE_MISCONFIGURED'
  | 'MODEL_UNAVAILABLE'
  | 'QUOTA_EXHAUSTED'
  | 'TEMPORARILY_UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'MODEL_NOT_ALLOWED'
  | 'PROVIDER_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'SERVER_CONFIGURATION_MISSING'
  | 'UNAUTHORIZED'
  | 'PROVIDER_ERROR';

export interface ProviderErrorPayload {
  error: {
    code: ProviderErrorCode;
    message: string;
    retryable: boolean;
  };
}

export interface GeminiGatewayRequest {
  provider: 'gemini';
  action: 'generate' | 'stream' | 'health';
  request: {
    model: string;
    /** Ordered server-side candidates. The gateway always tries every profile for
     * a better model before it considers the next model. */
    modelCandidates?: string[];
    contents: unknown;
    config?: Record<string, unknown>;
  };
}

export interface DeepSeekGatewayRequest {
  provider: 'deepseek';
  action: 'chat' | 'stream' | 'health';
  request: {
    model: string;
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    temperature?: number;
    max_tokens?: number;
    response_format?: { type: 'json_object' };
    thinking?: { type: 'disabled' };
  };
  /** Ephemeral BYOK fallback. It is sent only to this same-origin route and is never returned. */
  byokKey?: string;
}

export type ProviderGatewayRequest = GeminiGatewayRequest | DeepSeekGatewayRequest;

export interface GeminiGatewayResponse {
  text?: string;
  data?: string;
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
    [key: string]: unknown;
  }>;
  modelVersion?: string;
  promptFeedback?: unknown;
  responseId?: string;
  usageMetadata?: unknown;
  executionTarget?: {
    profileId: string;
    profileLabel: string;
    profileFingerprint: string;
    model: string;
    fallbackFrom?: string;
  };
}

export type ProviderStreamEnvelope =
  | { type: 'chunk'; data: GeminiGatewayResponse }
  | ({ type: 'error' } & ProviderErrorPayload);
