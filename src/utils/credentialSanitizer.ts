const CREDENTIAL_FIELDS = new Set([
  'deepseekkey',
  'deepseekkeys',
  'deepseekapikey',
  'geminikey',
  'geminikeys',
  'geminiapikey',
  'usergeminikeys',
  'openrouterkey',
  'authorization',
  'bearertoken',
  'accesstoken',
]);

const LEGACY_LOCAL_STORAGE_KEYS = [
  'app_deepseek_key',
  'deepseek_api_key',
  'app_gemini_key',
  'gemini_api_key',
  'app_openrouter_key',
];

export interface CredentialSanitizationResult<T> {
  value: T;
  removed: number;
}

function sanitizeValue(value: unknown, seen: WeakMap<object, unknown>, result: { removed: number }): unknown {
  if (Array.isArray(value)) {
    if (seen.has(value)) return seen.get(value);
    const copy: unknown[] = [];
    seen.set(value, copy);
    value.forEach(item => copy.push(sanitizeValue(item, seen, result)));
    return copy;
  }

  if (!value || typeof value !== 'object') return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  if (seen.has(value as object)) return seen.get(value as object);

  const copy: Record<string, unknown> = {};
  seen.set(value as object, copy);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (CREDENTIAL_FIELDS.has(key.replace(/[_-]/g, '').toLowerCase())) {
      result.removed += 1;
      continue;
    }
    copy[key] = sanitizeValue(child, seen, result);
  }
  return copy;
}

export function sanitizePersistedCredentials<T>(value: T): CredentialSanitizationResult<T> {
  const result = { removed: 0 };
  return {
    value: sanitizeValue(value, new WeakMap(), result) as T,
    removed: result.removed,
  };
}

export function purgeLegacyCredentialLocalStorage(storage: Pick<Storage, 'removeItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
  if (!storage) return;
  for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
    try { storage.removeItem(key); } catch { /* storage may be unavailable */ }
  }
}
