import React, { useEffect, useState } from 'react';
import { GEMINI_MODEL_REGISTRY } from '../../../../shared/geminiModelRegistry';
import { getGeminiProfiles, updateGeminiProfile, type GeminiProfileView } from '../../../services/api/geminiProfiles';

const modelLabel = (id: string) => GEMINI_MODEL_REGISTRY.find(model => model.id === id)?.label || id;

function statusLabel(status: string, retryAt: number | undefined, now: number): string {
  switch (status) {
    case 'READY': return 'Sẵn sàng';
    case 'COOLDOWN': return retryAt && now > 0
      ? `Đang chờ ${Math.max(1, Math.ceil((retryAt - now) / 1_000))} giây do rate limit`
      : 'Đang chờ do giới hạn tốc độ';
    case 'RATE_LIMITED': return retryAt && now > 0
      ? `Đang chờ ${Math.max(1, Math.ceil((retryAt - now) / 1_000))} giây do rate limit`
      : 'Đang chờ do giới hạn tốc độ';
    case 'QUOTA_EXHAUSTED': return 'Đã hết hạn mức ngày của model này';
    case 'MODEL_UNAVAILABLE': return 'Không khả dụng trên profile này';
    case 'MISCONFIGURED': return 'Cần kiểm tra Secret';
    case 'TEMPORARILY_UNAVAILABLE': return 'Tạm thời không khả dụng';
    case 'DISABLED': return 'Đã tắt';
    default: return status;
  }
}

export const GeminiProfilesTab: React.FC = () => {
  const [profiles, setProfiles] = useState<GeminiProfileView[]>([]);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(0);

  const load = async () => {
    try {
      setProfiles((await getGeminiProfiles()).profiles);
      setMessage('');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Không thể tải Gemini profiles.');
    }
  };

  // Profile refresh is external synchronization, not render-derived state.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    if (!profiles.some(profile => Object.values(profile.modelDetails || {}).some(detail => detail.status === 'COOLDOWN'))) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [profiles]);

  const update = async (payload: Record<string, unknown>) => {
    try {
      const result = await updateGeminiProfile(payload);
      setProfiles(result.profiles);
      setMessage(payload.action === 'add'
        ? `Tạo Secret ${result.addSecretName} trong Settings → Secrets, rồi tải lại ứng dụng.`
        : payload.action === 'test' ? 'Kiểm tra profile thành công.' : 'Đã cập nhật.');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Cập nhật thất bại.');
    }
  };

  return <div className="space-y-3 text-sm">
    <p className="text-slate-500">API key chỉ tồn tại trên server. Trình duyệt chỉ quản lý nhãn và trạng thái bật/tắt.</p>
    {profiles.length === 0 && <p className="rounded-lg bg-slate-50 p-3 text-slate-600 dark:bg-slate-800 dark:text-slate-300">Chưa có Gemini profile. Hãy thêm Secret đầu tiên trong AI Studio.</p>}
    {profiles.map(profile => <div key={profile.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-700">
      <div className="flex items-center justify-between gap-3">
        <input
          defaultValue={profile.label}
          aria-label={`Nhãn ${profile.fingerprint}`}
          onBlur={event => void update({ action: 'update', profileId: profile.id, label: event.target.value })}
          className="min-w-0 flex-1 bg-transparent font-semibold outline-none"
        />
        <span className={profile.status === 'READY' ? 'text-emerald-600' : 'text-amber-600'}>{statusLabel(
          profile.status,
          Object.values(profile.modelDetails || {}).find(detail => detail.status === profile.status)?.retryAt,
          now,
        )}</span>
      </div>
      <div className="mt-3 space-y-2">
        {Object.entries(profile.models).map(([model, status]) => {
          const detail = profile.modelDetails?.[model];
          return <div key={model} className="flex items-center justify-between gap-3 rounded bg-slate-50 px-2 py-1.5 dark:bg-slate-800">
            <div className="min-w-0"><div className="truncate font-medium">{modelLabel(model)}</div><div className="text-xs text-slate-500">{statusLabel(status, detail?.retryAt, now)}</div></div>
            <button className="shrink-0 text-xs underline" onClick={() => void update({ action: 'model', profileId: profile.id, model, enabled: status === 'DISABLED' })}>{status === 'DISABLED' ? 'Bật' : 'Tắt'}</button>
          </div>;
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3">
        <button className="underline" onClick={() => void update({ action: 'update', profileId: profile.id, disabled: profile.status !== 'DISABLED' })}>{profile.status === 'DISABLED' ? 'Bật profile' : 'Tắt profile'}</button>
        <button className="underline" onClick={() => void update({ action: 'test', profileId: profile.id })}>Kiểm tra</button>
        <button className="underline" onClick={() => void update({ action: 'remove', profileId: profile.id })}>Vô hiệu hóa</button>
      </div>
      <details className="mt-3 text-xs text-slate-500"><summary className="cursor-pointer">Chi tiết nâng cao</summary><div className="mt-1">Mã nhận diện: {profile.fingerprint}</div><div>Nhóm hạn mức: {profile.quotaGroup}</div></details>
    </div>)}
    <button className="rounded-lg bg-blue-600 px-3 py-2 text-white" onClick={() => void update({ action: 'add' })}>Thêm Gemini profile</button>
    <p className="rounded bg-amber-50 p-2 text-amber-800 dark:bg-amber-950 dark:text-amber-200">Ứng dụng sẽ cho biết tên Secret tiếp theo. Chỉ nhập credential trong AI Studio Settings → Secrets. Vô hiệu hóa không xóa Secret.</p>
    {message && <p role="status">{message}</p>}
  </div>;
};
