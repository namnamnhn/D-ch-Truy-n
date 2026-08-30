import React, { useEffect, useState } from 'react';
import { getGeminiProfiles, updateGeminiProfile, type GeminiProfileView } from '../../../services/api/geminiProfiles';

export const GeminiProfilesTab: React.FC = () => {
  const [profiles, setProfiles] = useState<GeminiProfileView[]>([]); const [message, setMessage] = useState('');
  const load = async () => { try { setProfiles((await getGeminiProfiles()).profiles); setMessage(''); } catch (error) { setMessage(error instanceof Error ? error.message : 'Không thể tải profiles.'); } };
  // Profile refresh is an external network synchronization, not a render-derived state update.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);
  const update = async (payload: Record<string, unknown>) => { try { const result = await updateGeminiProfile(payload); setProfiles(result.profiles); setMessage('Đã cập nhật metadata an toàn.'); } catch (error) { setMessage(error instanceof Error ? error.message : 'Cập nhật thất bại.'); } };
  return <div className="space-y-3 text-sm">
    <p className="text-slate-500">Secrets chỉ tồn tại trên server. Không thể nhập hoặc xem API key tại đây.</p>
    {profiles.map(profile => <div key={profile.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex justify-between gap-2"><input defaultValue={profile.label} aria-label={`Nhãn ${profile.fingerprint}`} onBlur={e => void update({ action: 'update', profileId: profile.id, label: e.target.value })} className="min-w-0 bg-transparent font-semibold" /><span>{profile.status}</span></div>
      <div className="text-xs text-slate-500">fingerprint {profile.fingerprint} · quota group {profile.quotaGroup}</div>
      <div className="mt-2 flex flex-wrap gap-2"><button onClick={() => void update({ action: 'update', profileId: profile.id, disabled: profile.status !== 'DISABLED' })}> {profile.status === 'DISABLED' ? 'Bật' : 'Tắt'} </button><button onClick={() => void update({ action: 'test', profileId: profile.id })}>Test</button>{Object.entries(profile.models).map(([model, status]) => <button key={model} title={model} onClick={() => void update({ action: 'model', profileId: profile.id, model, enabled: status === 'DISABLED' })}>{model}: {status}</button>)}</div>
    </div>)}
    <p className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Thêm profile: tạo Secret <code>GEMINI_PROFILE_{profiles.length + 1}_API_KEY</code> trong Settings → Secrets, rồi tải lại. “Remove” chỉ vô hiệu hóa; xóa Secret trên server mới xóa credential.</p>
    {message && <p role="status">{message}</p>}
  </div>;
};
