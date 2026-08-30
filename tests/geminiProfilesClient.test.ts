import { afterEach, describe, expect, it, vi } from 'vitest';
import { getGeminiProfiles, updateGeminiProfile } from '../src/services/api/geminiProfiles';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() { return values.size; },
    dump: () => JSON.stringify(Object.fromEntries(values)),
  };
}

const profile = {
  id: 'gemini-safe-id', label: 'Gemini 1', fingerprint: '0123456789abcdef', quotaGroup: 'project-one',
  status: 'READY', models: { 'gemini-3.7-flash': 'READY' },
  modelDetails: { 'gemini-3.7-flash': { status: 'READY' } },
};

describe('Gemini profile browser metadata', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('persists only safe metadata and never a credential-looking label', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ profiles: [profile] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })));
    await updateGeminiProfile({ action: 'update', profileId: profile.id, label: 'Tài khoản viết truyện', disabled: false });
    await updateGeminiProfile({ action: 'update', profileId: profile.id, label: 'AIzaCredentialSentinel_12345678901234567890' });
    expect(storage.dump()).toContain('Tài khoản viết truyện');
    expect(storage.dump()).not.toContain('AIzaCredentialSentinel');
  });

  it('replays safe preferences after a server cold start', async () => {
    const storage = memoryStorage({
      gemini_profile_metadata_v1: JSON.stringify({ [profile.id]: { label: 'Nguồn dự phòng', disabled: true, disabledModels: ['gemini-3.7-flash'] } }),
    });
    vi.stubGlobal('localStorage', storage);
    const fetchMock = vi.fn(async (...args: [string, RequestInit?]) => {
      void args;
      return new Response(JSON.stringify({ profiles: [profile] }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    await getGeminiProfiles();
    const posted = fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)));
    expect(posted).toEqual([
      { action: 'update', profileId: profile.id, label: 'Nguồn dự phòng', disabled: true },
      { action: 'model', profileId: profile.id, model: 'gemini-3.7-flash', enabled: false },
    ]);
    expect(storage.dump()).not.toMatch(/AIza|api[_-]?key/i);
  });
});
