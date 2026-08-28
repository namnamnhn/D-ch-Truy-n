import { JsonObject, JsonValue } from './types';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

export function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return value;
}

export function normalizePositiveInteger(value: unknown): number | null {
  const number = normalizeFiniteNumber(value);
  if (number === null || !Number.isInteger(number) || number < 1) return null;
  return number;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

export function normalizeJsonObject(value: unknown): JsonObject | null {
  if (!isRecord(value) || !isJsonValue(value)) return null;
  return value;
}

export function normalizeJsonArray(value: unknown): JsonValue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isJsonValue);
}

export function stripJsonFence(value: string): string {
  return value
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

export function parseJsonObject(value: string, context: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: JSON không hợp lệ (${detail}).`);
  }
  const object = normalizeJsonObject(parsed);
  if (!object) throw new Error(`${context}: giá trị gốc phải là một JSON object hợp lệ.`);
  return object;
}
