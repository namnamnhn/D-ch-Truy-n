import { GEMINI_PROFILES_PATH } from '../../../shared/providerContract';
export interface GeminiProfileView { id: string; label: string; fingerprint: string; quotaGroup: string; status: string; models: Record<string, string>; }
export async function getGeminiProfiles(): Promise<{ profiles: GeminiProfileView[] }> {
  const response = await fetch(GEMINI_PROFILES_PATH, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: { message: 'Không thể đọc Gemini profiles.' } }))).error?.message || 'Không thể đọc Gemini profiles.');
  return response.json();
}
export async function updateGeminiProfile(payload: Record<string, unknown>): Promise<{ profiles: GeminiProfileView[]; addSecretName?: string }> {
  const response = await fetch(GEMINI_PROFILES_PATH, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: { message: 'Không thể cập nhật profile.' } }))).error?.message || 'Không thể cập nhật profile.');
  return response.json();
}
