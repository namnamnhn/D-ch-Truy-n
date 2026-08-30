import { createHmac } from 'node:crypto';
import { APPROVED_GEMINI_MODEL_IDS } from '../shared/geminiModelRegistry';

export type GeminiTargetStatus = 'READY' | 'COOLDOWN' | 'QUOTA_EXHAUSTED' | 'MODEL_UNAVAILABLE' | 'MISCONFIGURED' | 'TEMPORARILY_UNAVAILABLE' | 'DISABLED';
export interface GeminiProfileDto { id: string; label: string; fingerprint: string; status: GeminiTargetStatus; models: Record<string, GeminiTargetStatus>; quotaGroup: string; }
interface Profile { id: string; label: string; key: string; fingerprint: string; quotaGroup: string; disabled: boolean; }
interface TargetState { status: GeminiTargetStatus; until?: number; disabled?: boolean; }
export interface GeminiLease { readonly id: string; readonly profile: Profile; readonly model: string; readonly group: string; readonly issuedAt: number; }

const envToken = /^GEMINI_PROFILE_([A-Z0-9_]+)_API_KEY$/;
const SAFE_TOKEN = /^[A-Z0-9_]+$/;
const hmac = (value: string, salt: string) => createHmac('sha256', salt).update(value).digest('hex').slice(0, 16);

export class GeminiScheduler {
  private profiles: Profile[] = [];
  private states = new Map<string, TargetState>();
  private cursor = new Map<string, number>();
  private sequence = 0;
  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly now = () => Date.now()) { this.refresh(); }
  refresh(): void {
    const salt = this.env.GEMINI_PROFILE_FINGERPRINT_SECRET || 'private-aistudio-profile-fingerprint';
    const found: Array<{ token: string; key: string }> = [];
    if (this.env.GEMINI_API_KEY?.trim()) found.push({ token: 'DEFAULT', key: this.env.GEMINI_API_KEY.trim() });
    for (const [name, raw] of Object.entries(this.env)) {
      const match = name.match(envToken); if (match && raw?.trim()) found.push({ token: match[1], key: raw.trim() });
    }
    const seen = new Set<string>();
    this.profiles = found.sort((a, b) => a.token.localeCompare(b.token)).flatMap(({ token, key }) => {
      const fingerprint = hmac(key, salt); if (seen.has(fingerprint)) return []; seen.add(fingerprint);
      const prefix = token === 'DEFAULT' ? '' : `GEMINI_PROFILE_${token}_`;
      return [{ id: `gemini-${hmac(`${token}:${fingerprint}`, salt)}`, key, fingerprint, label: this.env[`${prefix}LABEL`]?.trim().slice(0, 80) || (token === 'DEFAULT' ? 'Gemini mặc định' : `Gemini ${token}`), quotaGroup: this.env[`${prefix}QUOTA_GROUP`]?.trim().slice(0, 80) || fingerprint, disabled: this.env[`${prefix}DISABLED`]?.toLowerCase() === 'true' }];
    });
  }
  private key(group: string, model: string) { return `${group}\u0000${model}`; }
  private state(profile: Profile, model: string): TargetState {
    if (profile.disabled) return { status: 'DISABLED' };
    const state = this.states.get(this.key(profile.quotaGroup, model));
    if (state?.until && state.until <= this.now()) { this.states.delete(this.key(profile.quotaGroup, model)); return { status: 'READY' }; }
    return state || { status: 'READY' };
  }
  getProfiles(): GeminiProfileDto[] { return this.profiles.map(profile => ({ id: profile.id, label: profile.label, fingerprint: profile.fingerprint, quotaGroup: profile.quotaGroup, status: APPROVED_GEMINI_MODEL_IDS.some(model => this.state(profile, model).status === 'READY') ? (profile.disabled ? 'DISABLED' : 'READY') : this.state(profile, APPROVED_GEMINI_MODEL_IDS[0]).status, models: Object.fromEntries(APPROVED_GEMINI_MODEL_IDS.map(model => [model, this.state(profile, model).status])) })); }
  updateProfile(id: string, changes: { label?: string; quotaGroup?: string; disabled?: boolean }): GeminiProfileDto | undefined {
    const p = this.profiles.find(item => item.id === id); if (!p) return undefined;
    if (changes.label !== undefined) p.label = changes.label.trim().slice(0, 80) || p.label;
    if (changes.quotaGroup !== undefined) p.quotaGroup = changes.quotaGroup.trim().slice(0, 80) || p.quotaGroup;
    if (changes.disabled !== undefined) p.disabled = changes.disabled;
    return this.getProfiles().find(item => item.id === id);
  }
  setModelEnabled(id: string, model: string, enabled: boolean): boolean {
    const p = this.profiles.find(item => item.id === id); if (!p || !APPROVED_GEMINI_MODEL_IDS.includes(model)) return false;
    const key = this.key(p.quotaGroup, model); if (!enabled) this.states.set(key, { status: 'DISABLED', disabled: true }); else if (this.states.get(key)?.disabled) this.states.delete(key); return true;
  }
  acquire(modelCandidates: readonly string[]): GeminiLease | undefined {
    for (const model of modelCandidates) {
      const targets = this.profiles.filter(profile => this.state(profile, model).status === 'READY');
      if (!targets.length) continue;
      const key = `rr:${model}`, index = this.cursor.get(key) || 0, profile = targets[index % targets.length]; this.cursor.set(key, index + 1);
      return Object.freeze({ id: `lease-${++this.sequence}`, profile, model, group: profile.quotaGroup, issuedAt: this.now() });
    }
    return undefined;
  }
  complete(lease: GeminiLease, error?: unknown): GeminiTargetStatus {
    if (!error) return this.state(lease.profile, lease.model).status;
    const raw = error as { status?: number; message?: string; headers?: Headers }; const text = String(raw?.message || error).toLowerCase();
    if (/abort/.test(text)) return this.state(lease.profile, lease.model).status;
    const key = this.key(lease.group, lease.model); let status: GeminiTargetStatus = 'TEMPORARILY_UNAVAILABLE'; let until = this.now() + 5_000 + Math.floor(Math.random() * 1_000);
    if (raw.status === 401 || raw.status === 403) status = 'MISCONFIGURED';
    else if (raw.status === 404) status = 'MODEL_UNAVAILABLE';
    else if (raw.status === 429 && /(quota_exceeded|daily|per day|daily quota)/.test(text)) status = 'QUOTA_EXHAUSTED';
    else if (raw.status === 429 || /rate_limit_exceeded|too many requests|retryinfo/.test(text)) { status = 'COOLDOWN'; const retry = raw.headers?.get('retry-after'); until = this.now() + Math.min(60_000, Math.max(1_000, Number(retry || 5) * 1_000)); }
    this.states.set(key, { status, ...(status === 'COOLDOWN' || status === 'TEMPORARILY_UNAVAILABLE' ? { until } : {}) }); return status;
  }
}

export const isPrivateAiStudio = (env: NodeJS.ProcessEnv) => env.APP_DEPLOYMENT_MODE === 'private-aistudio';
export const isSameOriginBrowserRequest = (request: { headers: { host?: string; origin?: string; ['sec-fetch-site']?: string } }) => {
  const site = request.headers['sec-fetch-site']; if (site && site !== 'same-origin' && site !== 'same-site') return false;
  const origin = request.headers.origin; if (!origin) return !site; // non-browser test/runtime requests are still policy-gated by deployment mode
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
};
export const isSafeProfileToken = (value: string) => SAFE_TOKEN.test(value);
