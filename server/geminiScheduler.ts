import { createHmac } from 'node:crypto';
import { APPROVED_GEMINI_MODEL_IDS } from '../shared/geminiModelRegistry';

export type GeminiTargetStatus =
  | 'READY' | 'COOLDOWN' | 'RATE_LIMITED' | 'QUOTA_EXHAUSTED'
  | 'MODEL_UNAVAILABLE' | 'MISCONFIGURED' | 'TEMPORARILY_UNAVAILABLE' | 'DISABLED';
export interface GeminiProfileDto {
  id: string;
  label: string;
  fingerprint: string;
  status: GeminiTargetStatus;
  models: Record<string, GeminiTargetStatus>;
  modelDetails: Record<string, { status: GeminiTargetStatus; retryAt?: number }>;
  quotaGroup: string;
}
interface Profile { id: string; label: string; key: string; fingerprint: string; quotaGroup: string; disabled: boolean; }
interface TargetState { status: GeminiTargetStatus; until?: number; }
export interface GeminiLease { readonly id: string; readonly profile: Readonly<Profile>; readonly model: string; readonly group: string; readonly issuedAt: number; }

const envToken = /^GEMINI_PROFILE_([A-Z0-9_]+)_API_KEY$/;
const SAFE_TOKEN = /^[A-Z0-9_]+$/;
const CREDENTIAL_LIKE = /(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,})/;
const hmac = (value: string, salt: string) => createHmac('sha256', salt).update(value).digest('hex').slice(0, 16);
export const isSafeProfileLabel = (value: string) => !CREDENTIAL_LIKE.test(value);
const pacificClock = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Google daily quotas reset on the provider's Pacific day; minute scanning is DST-safe. */
export const nextPacificMidnight = (now: number): number => {
  for (let candidate = Math.floor(now / 60_000) * 60_000 + 60_000; candidate <= now + 30 * 60 * 60_000; candidate += 60_000) {
    const parts = Object.fromEntries(pacificClock.formatToParts(new Date(candidate)).map(part => [part.type, part.value]));
    if (parts.hour === '00' && parts.minute === '00') return candidate;
  }
  throw new Error('Could not calculate the next America/Los_Angeles midnight.');
};

/**
 * Credentials are profile-local. Quota is deliberately group/model scoped: two
 * legitimate profiles from one Google project must not pretend to have two quotas.
 */
export class GeminiScheduler {
  private profiles: Profile[] = [];
  private readonly groupStates = new Map<string, TargetState>();
  private readonly profileStates = new Map<string, TargetState>();
  private readonly profileGlobalStates = new Map<string, TargetState>();
  private readonly disabledModels = new Set<string>();
  private readonly cursor = new Map<string, number>();
  private sequence = 0;

  constructor(private readonly env: NodeJS.ProcessEnv = process.env, private readonly now = () => Date.now()) { this.refresh(); }

  refresh(): void {
    const salt = this.env.GEMINI_PROFILE_FINGERPRINT_SECRET || 'private-aistudio-profile-fingerprint';
    const found: Array<{ token: string; key: string }> = [];
    if (this.env.GEMINI_API_KEY?.trim()) found.push({ token: 'DEFAULT', key: this.env.GEMINI_API_KEY.trim() });
    for (const [name, raw] of Object.entries(this.env)) {
      const match = name.match(envToken);
      if (match && raw?.trim()) found.push({ token: match[1], key: raw.trim() });
    }
    const seen = new Set<string>();
    this.profiles = found.sort((a, b) => a.token.localeCompare(b.token)).flatMap(({ token, key }) => {
      const fingerprint = hmac(key, salt);
      if (seen.has(fingerprint)) return [];
      seen.add(fingerprint);
      const prefix = token === 'DEFAULT' ? '' : `GEMINI_PROFILE_${token}_`;
      const fallbackLabel = token === 'DEFAULT' ? 'Gemini mặc định' : `Gemini ${token}`;
      const configuredLabel = this.env[`${prefix}LABEL`]?.trim().slice(0, 80);
      return [{
        id: `gemini-${hmac(`${token}:${fingerprint}`, salt)}`,
        key,
        fingerprint,
        label: configuredLabel && isSafeProfileLabel(configuredLabel) ? configuredLabel : fallbackLabel,
        quotaGroup: this.env[`${prefix}QUOTA_GROUP`]?.trim().slice(0, 80) || fingerprint,
        disabled: this.env[`${prefix}DISABLED`]?.toLowerCase() === 'true',
      }];
    });
  }

  private groupKey(group: string, model: string) { return `${group}\u0000${model}`; }
  private profileKey(profile: Pick<Profile, 'id'>, model: string) { return `${profile.id}\u0000${model}`; }
  private active(state: TargetState | undefined): TargetState | undefined {
    if (state?.until && state.until <= this.now()) return undefined;
    return state;
  }
  private clearExpired(): void {
    for (const [key, state] of this.groupStates) if (!this.active(state)) this.groupStates.delete(key);
    for (const [key, state] of this.profileStates) if (!this.active(state)) this.profileStates.delete(key);
    for (const [key, state] of this.profileGlobalStates) if (!this.active(state)) this.profileGlobalStates.delete(key);
  }
  private state(profile: Profile, model: string): TargetState {
    this.clearExpired();
    if (profile.disabled || this.disabledModels.has(this.profileKey(profile, model))) return { status: 'DISABLED' };
    return this.profileGlobalStates.get(profile.id)
      || this.profileStates.get(this.profileKey(profile, model))
      || this.groupStates.get(this.groupKey(profile.quotaGroup, model))
      || { status: 'READY' };
  }

  getProfiles(): GeminiProfileDto[] {
    return this.profiles.map(profile => {
      const models = Object.fromEntries(APPROVED_GEMINI_MODEL_IDS.map(model => [model, this.state(profile, model)])) as Record<string, TargetState>;
      const statuses = Object.fromEntries(Object.entries(models).map(([model, state]) => [model, state.status]));
      const modelDetails = Object.fromEntries(Object.entries(models).map(([model, state]) => [model, {
        status: state.status, ...(state.until ? { retryAt: state.until } : {}),
      }]));
      const status = profile.disabled ? 'DISABLED' : Object.values(models).some(item => item.status === 'READY')
        ? 'READY' : (models[APPROVED_GEMINI_MODEL_IDS[0]]?.status || 'TEMPORARILY_UNAVAILABLE');
      return { id: profile.id, label: profile.label, fingerprint: profile.fingerprint, quotaGroup: profile.quotaGroup, status, models: statuses, modelDetails };
    });
  }
  updateProfile(id: string, changes: { label?: string; disabled?: boolean }): GeminiProfileDto | undefined {
    const profile = this.profiles.find(item => item.id === id);
    if (!profile) return undefined;
    if (changes.label !== undefined) {
      const label = changes.label.trim().slice(0, 80);
      if (!isSafeProfileLabel(label)) return undefined;
      profile.label = label || profile.label;
    }
    if (changes.disabled !== undefined) profile.disabled = changes.disabled;
    return this.getProfiles().find(item => item.id === id);
  }
  setModelEnabled(id: string, model: string, enabled: boolean): boolean {
    const profile = this.profiles.find(item => item.id === id);
    if (!profile || !APPROVED_GEMINI_MODEL_IDS.includes(model)) return false;
    const key = this.profileKey(profile, model);
    if (enabled) this.disabledModels.delete(key); else this.disabledModels.add(key);
    return true;
  }
  acquire(modelCandidates: readonly string[], excludedLeaseIds = new Set<string>()): GeminiLease | undefined {
    for (const model of modelCandidates) {
      const ready = this.profiles.filter(profile => this.state(profile, model).status === 'READY');
      if (!ready.length) continue;
      const cursorKey = `rr:${model}`;
      const start = this.cursor.get(cursorKey) || 0;
      for (let offset = 0; offset < ready.length; offset++) {
        const profile = ready[(start + offset) % ready.length];
        const lease = Object.freeze({ id: `lease-${++this.sequence}`, profile: Object.freeze({ ...profile }), model, group: profile.quotaGroup, issuedAt: this.now() });
        if (excludedLeaseIds.has(`${profile.id}\u0000${model}`)) continue;
        this.cursor.set(cursorKey, start + offset + 1);
        return lease;
      }
    }
    return undefined;
  }
  hasReady(modelCandidates: readonly string[]): boolean {
    return modelCandidates.some(model => this.profiles.some(profile => this.state(profile, model).status === 'READY'));
  }
  /** Earliest provider-directed retry across the requested targets. Long daily
   * exhaustion windows are deliberately not treated as short request waits. */
  nextRetryDelay(modelCandidates: readonly string[], maximumMs = 60_000): number | undefined {
    const now = this.now();
    const delays = this.profiles.flatMap(profile => modelCandidates.flatMap(model => {
      const state = this.state(profile, model);
      if (state.status !== 'COOLDOWN') return [];
      const until = state.until;
      const delay = until ? until - now : 0;
      return delay > 0 && delay <= maximumMs ? [delay] : [];
    }));
    return delays.length ? Math.max(1, Math.min(...delays)) : undefined;
  }
  acquireForProfile(profileId: string, model: string): GeminiLease | undefined {
    const profile = this.profiles.find(item => item.id === profileId);
    if (!profile || this.state(profile, model).status !== 'READY') return undefined;
    return Object.freeze({ id: `lease-${++this.sequence}`, profile: Object.freeze({ ...profile }), model, group: profile.quotaGroup, issuedAt: this.now() });
  }
  nextProfileSecretName(): string {
    let number = 1;
    while (this.env[`GEMINI_PROFILE_${number}_API_KEY`]?.trim()) number++;
    return `GEMINI_PROFILE_${number}_API_KEY`;
  }

  /** Attribute every completion to the immutable lease that issued the call. */
  complete(lease: GeminiLease, error?: unknown): GeminiTargetStatus {
    const current = this.state(lease.profile, lease.model);
    if (!error) return current.status;
    const raw = error as { status?: number; statusCode?: number; message?: string; headers?: Headers | Record<string, string | undefined>; details?: unknown };
    const statusCode = Number(raw?.status || raw?.statusCode || 0);
    const text = `${raw?.message || error} ${JSON.stringify(raw?.details || '')}`.toLowerCase();
    if (/abort/.test(text)) return current.status;
    const retryAfter = retryDelayMs(raw, text);
    const profileKey = this.profileKey(lease.profile, lease.model);
    const groupKey = this.groupKey(lease.group, lease.model);
    let next: TargetState;
    let target: Map<string, TargetState>;
    // A caller/config payload error is target-independent. Do not poison a
    // credential or waste calls by replaying the same malformed request.
    if (statusCode === 400) return current.status;
    if (statusCode === 401 || statusCode === 403) {
      next = { status: 'MISCONFIGURED' }; target = this.profileGlobalStates;
    } else if (statusCode === 404 || /model.*(?:not found|unsupported|unavailable)/.test(text)) {
      next = { status: 'MODEL_UNAVAILABLE' }; target = this.profileStates;
    } else if (statusCode === 429 && /quota_exceeded|daily|per day|daily quota/.test(text)) {
      next = { status: 'QUOTA_EXHAUSTED', until: nextPacificMidnight(this.now()) }; target = this.groupStates;
    } else if (statusCode === 429 || /rate_limit_exceeded|too many requests|resource_exhausted|retryinfo/.test(text)) {
      next = { status: retryAfter ? 'COOLDOWN' : 'RATE_LIMITED', until: this.now() + (retryAfter || 5_000) }; target = this.groupStates;
    } else {
      next = { status: 'TEMPORARILY_UNAVAILABLE', until: this.now() + (retryAfter || 5_000) }; target = this.profileStates;
    }
    target.set(target === this.groupStates ? groupKey : target === this.profileGlobalStates ? lease.profile.id : profileKey, next);
    return next.status;
  }
}

function retryDelayMs(raw: { headers?: Headers | Record<string, string | undefined>; message?: string; details?: unknown }, text: string): number | undefined {
  const headers = raw.headers;
  const retryAfter = headers instanceof Headers ? headers.get('retry-after') : headers?.['retry-after'] || headers?.['Retry-After'];
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, Math.max(1_000, seconds * 1_000));
  const match = text.match(/retry(?:delay|_delay)?["':= ]+(\d+(?:\.\d+)?)s/i) || text.match(/retryinfo[\s\S]{0,100}?seconds["':= ]+(\d+)/i);
  return match ? Math.min(60_000, Math.max(1_000, Number(match[1]) * 1_000)) : undefined;
}

export const isPrivateAiStudio = (env: NodeJS.ProcessEnv) => env.APP_DEPLOYMENT_MODE === 'private-aistudio';
export const isSameOriginBrowserRequest = (request: { headers: { host?: string; origin?: string; ['sec-fetch-site']?: string } }) => {
  const site = request.headers['sec-fetch-site'];
  if (site === 'cross-site') return false;
  // AI Studio's browser request carries this browser-controlled signal while
  // its public Origin legitimately differs from the internal proxy Host.
  if (site === 'same-origin') return true;
  const origin = request.headers.origin;
  if (!origin) return !site;
  try {
    const url = new URL(origin);
    const host = request.headers.host;
    return Boolean(host) && url.host === host && (url.protocol === 'https:' || url.protocol === 'http:');
  } catch { return false; }
};
export const isSafeProfileToken = (value: string) => SAFE_TOKEN.test(value);
