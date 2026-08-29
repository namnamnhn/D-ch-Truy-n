const REDACTED_API_KEY = '[REDACTED_API_KEY]';
const REDACTED_TOKEN = '[REDACTED_TOKEN]';

/**
 * Redacts provider credentials and explicit credential forms without treating
 * ordinary manuscript prose as secret material.
 */
export function redactProviderSecrets(value: unknown): string {
  let text = typeof value === 'string'
    ? value
    : value instanceof Error
      ? (value.stack || value.message)
      : String(value ?? '');

  text = text
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, REDACTED_API_KEY)
    .replace(/\bsk-[0-9A-Za-z_-]{12,}\b/g, REDACTED_API_KEY)
    .replace(/\b(Bearer\s+)[0-9A-Za-z._~+/=-]{12,}\b/gi, `$1${REDACTED_TOKEN}`)
    .replace(/\b((?:GEMINI|DEEPSEEK)_API_KEY\s*[:=]\s*)[^\s,;"']+/gi, `$1${REDACTED_API_KEY}`)
    .replace(/\b(Authorization\s*[:=]\s*(?:Bearer\s+)?)[^\s,;"']+/gi, `$1${REDACTED_TOKEN}`)
    .replace(/([?&](?:key|api_key|apikey|access_token|token)=)[^&#\s]+/gi, `$1${REDACTED_TOKEN}`);

  return text;
}
