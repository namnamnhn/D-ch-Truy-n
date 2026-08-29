export const PROVIDER_GATEWAY_PATH = '/api/provider';

export const APPROVED_GEMINI_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemma-4-31b-it',
  'gemma-4-26b-a4b-it',
  'gemini-3.1-flash-lite-image',
] as const;

export const APPROVED_DEEPSEEK_MODELS = [
  'deepseek-v4-pro',
  'deepseek-v4-flash',
] as const;

export type ProviderErrorCode =
  | 'ABORTED'
  | 'AUTHORIZATION_NOT_CONFIGURED'
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
}

export type ProviderStreamEnvelope =
  | { type: 'chunk'; data: GeminiGatewayResponse }
  | ({ type: 'error' } & ProviderErrorPayload);
