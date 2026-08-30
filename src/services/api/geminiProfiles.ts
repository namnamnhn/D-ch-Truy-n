import { GEMINI_PROFILES_PATH } from '../../../shared/providerContract';

export interface GeminiProfileView {
  id: string;
  label: string;
  fingerprint: string;
  quotaGroup: string;
  status: string;
  models: Record<string, string>;
  modelDetails?: Record<string, { status: string; retryAt?: number }>;
}

interface GeminiProfilePreference {
  label?: string;
  disabled?: boolean;
  disabledModels?: string[];
}

const PROFILE_PREFERENCES_KEY = 'gemini_profile_metadata_v1';
const CREDENTIAL_LIKE = /(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,})/;

function loadPreferences(): Record<string, GeminiProfilePreference> {
  if (typeof localStorage === 'undefined') return {};
  try {
    const value = JSON.parse(localStorage.getItem(PROFILE_PREFERENCES_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function savePreference(payload: Record<string, unknown>): void {
  if (typeof localStorage === 'undefined' || typeof payload.profileId !== 'string') return;
  const preferences = loadPreferences();
  const current = preferences[payload.profileId] || {};
  if (payload.action === 'update') {
    if (typeof payload.label === 'string' && !CREDENTIAL_LIKE.test(payload.label)) current.label = payload.label.slice(0, 80);
    if (typeof payload.disabled === 'boolean') current.disabled = payload.disabled;
  } else if (payload.action === 'remove') {
    current.disabled = true;
  } else if (payload.action === 'model' && typeof payload.model === 'string' && typeof payload.enabled === 'boolean') {
    const disabled = new Set(current.disabledModels || []);
    if (payload.enabled) disabled.delete(payload.model); else disabled.add(payload.model);
    current.disabledModels = [...disabled];
  }
  preferences[payload.profileId] = current;
  localStorage.setItem(PROFILE_PREFERENCES_KEY, JSON.stringify(preferences));
}

async function postProfileAction(payload: Record<string, unknown>): Promise<{ profiles: GeminiProfileView[]; addSecretName?: string }> {
  const response = await fetch(GEMINI_PROFILES_PATH, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const fallback = { error: { message: 'Không thể cập nhật profile.' } };
    throw new Error((await response.json().catch(() => fallback)).error?.message || fallback.error.message);
  }
  return response.json();
}

export async function getGeminiProfiles(): Promise<{ profiles: GeminiProfileView[] }> {
  const response = await fetch(GEMINI_PROFILES_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) {
    const fallback = { error: { message: 'Không thể đọc Gemini profiles.' } };
    throw new Error((await response.json().catch(() => fallback)).error?.message || fallback.error.message);
  }
  let result = await response.json() as { profiles: GeminiProfileView[] };
  const preferences = loadPreferences();
  // AI Studio Secrets cannot be created or mutated at runtime. Safe display
  // metadata may be browser-owned and is replayed to the in-memory scheduler
  // after a server cold start; credential material never enters this store.
  for (const profile of result.profiles) {
    const preference = preferences[profile.id];
    if (!preference) continue;
    if (preference.label !== undefined || preference.disabled !== undefined) {
      result = await postProfileAction({ action: 'update', profileId: profile.id, label: preference.label, disabled: preference.disabled });
    }
    if (preference.disabledModels) {
      for (const model of Object.keys(profile.models)) {
        result = await postProfileAction({
          action: 'model', profileId: profile.id, model, enabled: !preference.disabledModels.includes(model),
        });
      }
    }
  }
  return result;
}

export async function updateGeminiProfile(payload: Record<string, unknown>): Promise<{ profiles: GeminiProfileView[]; addSecretName?: string }> {
  const result = await postProfileAction(payload);
  savePreference(payload);
  return result;
}
