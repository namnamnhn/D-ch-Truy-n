import { describe, expect, it } from 'vitest';
import { GeminiScheduler, nextPacificMidnight } from '../server/geminiScheduler';
import { smartExecution } from '../src/services/api/gemini';
import { ProviderGatewayError } from '../src/services/api/providerGatewayClient';
import { quotaManager } from '../src/utils/quotaManager';

const model = 'gemini-3.7-flash';

describe('GeminiScheduler', () => {
  it('uses another profile after an ambiguous 429 and does not poison a later credential result', () => {
    const scheduler = new GeminiScheduler({
      GEMINI_PROFILE_1_API_KEY: 'one', GEMINI_PROFILE_1_QUOTA_GROUP: 'one',
      GEMINI_PROFILE_2_API_KEY: 'two', GEMINI_PROFILE_2_QUOTA_GROUP: 'two',
    });
    const first = scheduler.acquire([model])!;
    expect(scheduler.complete(first, Object.assign(new Error('RESOURCE_EXHAUSTED'), { status: 429 }))).toBe('RATE_LIMITED');
    const second = scheduler.acquire([model])!;
    expect(second.profile.id).not.toBe(first.profile.id);
    expect(scheduler.complete(first, Object.assign(new Error('bad credential'), { status: 401 }))).toBe('MISCONFIGURED');
    expect(scheduler.getProfiles().find(p => p.id === second.profile.id)?.models[model]).toBe('READY');
  });

  it('shares explicit daily quota by group and resets at Pacific midnight across PST/PDT', () => {
    let now = Date.UTC(2026, 0, 2, 7, 59, 59); // Jan 1 23:59:59 PST
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one', GEMINI_PROFILE_1_QUOTA_GROUP: 'shared', GEMINI_PROFILE_2_API_KEY: 'two', GEMINI_PROFILE_2_QUOTA_GROUP: 'shared' }, () => now);
    const lease = scheduler.acquire([model])!;
    expect(scheduler.complete(lease, Object.assign(new Error('daily quota exceeded'), { status: 429 }))).toBe('QUOTA_EXHAUSTED');
    expect(scheduler.acquire([model])).toBeUndefined();
    now += 2_000;
    expect(scheduler.acquire([model])).toBeDefined();
    expect(nextPacificMidnight(Date.UTC(2026, 2, 9, 6, 59, 59))).toBe(Date.UTC(2026, 2, 9, 7, 0, 0)); // PDT
  });

  it('marks every model on one bad credential misconfigured without harming another profile', () => {
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one', GEMINI_PROFILE_2_API_KEY: 'two' });
    const first = scheduler.acquire([model])!;
    scheduler.complete(first, Object.assign(new Error('unauthorized'), { status: 401 }));
    const bad = scheduler.getProfiles().find(profile => profile.id === first.profile.id)!;
    expect(Object.values(bad.models).every(status => status === 'MISCONFIGURED')).toBe(true);
    expect(scheduler.acquire([model])?.profile.id).not.toBe(first.profile.id);
  });

  it('does not allow browser metadata updates to migrate quota groups', () => {
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one', GEMINI_PROFILE_1_QUOTA_GROUP: 'server-owned' });
    const profile = scheduler.getProfiles()[0];
    scheduler.updateProfile(profile.id, { label: 'safe', disabled: false } as any);
    expect(scheduler.getProfiles()[0].quotaGroup).toBe('server-owned');
  });

  it('expires temporary cooldowns and resumes the affected quota group', () => {
    let now = 1_000;
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one' }, () => now);
    const lease = scheduler.acquire([model])!;
    expect(scheduler.complete(lease, Object.assign(new Error('too many requests'), {
      status: 429, headers: { 'retry-after': '2' },
    }))).toBe('COOLDOWN');
    expect(scheduler.nextRetryDelay([model])).toBe(2_000);
    expect(scheduler.acquire([model])).toBeUndefined();
    now += 2_001;
    expect(scheduler.acquire([model])).toBeDefined();
  });

  it('keeps model unavailability scoped to one profile and model', () => {
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one', GEMINI_PROFILE_2_API_KEY: 'two' });
    const first = scheduler.acquire([model])!;
    expect(scheduler.complete(first, Object.assign(new Error('model not found'), { status: 404 }))).toBe('MODEL_UNAVAILABLE');
    expect(scheduler.acquire([model])?.profile.id).not.toBe(first.profile.id);
    expect(scheduler.getProfiles().find(profile => profile.id === first.profile.id)?.models['gemini-3.5-flash']).toBe('READY');
  });

  it('honors profile and model disable controls without altering other targets', () => {
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one', GEMINI_PROFILE_2_API_KEY: 'two' });
    const first = scheduler.getProfiles()[0];
    scheduler.setModelEnabled(first.id, model, false);
    expect(scheduler.getProfiles().find(profile => profile.id === first.id)?.models[model]).toBe('DISABLED');
    expect(scheduler.acquire([model])?.profile.id).not.toBe(first.id);
    scheduler.updateProfile(first.id, { disabled: true });
    expect(scheduler.getProfiles().find(profile => profile.id === first.id)?.status).toBe('DISABLED');
  });

  it('does not poison a profile for malformed target-independent requests', () => {
    const scheduler = new GeminiScheduler({ GEMINI_PROFILE_1_API_KEY: 'one' });
    const lease = scheduler.acquire([model])!;
    expect(scheduler.complete(lease, Object.assign(new Error('bad request'), { status: 400 }))).toBe('READY');
    expect(scheduler.acquire([model])).toBeDefined();
  });

  it('does not reinterpret normalized server rate state with legacy blind retries', async () => {
    quotaManager.clearUsage();
    let calls = 0;
    await expect(smartExecution([model], async () => {
      calls++;
      throw new ProviderGatewayError('Đang chờ theo Retry-After.', 'RATE_LIMITED', 429, true);
    }, 'scheduler-owned')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(calls).toBe(1);
    expect(quotaManager.isModelDepleted(model)).toBe(false);
  });
});
