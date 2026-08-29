import React, { useEffect, useState } from 'react';
import { Coffee, ArrowRight, KeyRound, Loader2 } from 'lucide-react';
import { APP_FULL_TITLE } from '../changelog';
import { ACCESS_CONFIG } from '../constants';
import type { AuthStatusCode, AuthStatusResponse } from '../../shared/authContract';
import { getAuthStatus, loginWithAccessCode } from '../services/api/authClient';

const safeMessage = (status: AuthStatusCode): string => ({
  AUTHENTICATED: '',
  AUTH_REQUIRED: 'Vui lòng nhập mã truy cập để tiếp tục.',
  INVALID_CODE: 'Mã truy cập không đúng.',
  AUTH_NOT_CONFIGURED: 'Máy chủ chưa được cấu hình xác thực truy cập.',
  SESSION_EXPIRED: 'Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.',
  ENTITLEMENT_EXPIRED: 'Phiên bản hiện tại đã hết hạn sử dụng.',
  RATE_LIMITED: 'Có quá nhiều lần thử. Vui lòng thử lại sau.',
  UNAUTHORIZED_REQUEST: 'Yêu cầu xác thực không hợp lệ.',
  SERVER_UNAVAILABLE: 'Không thể kết nối máy chủ xác thực.',
})[status];

export const IntroPage: React.FC<{ onEnter: () => void }> = ({ onEnter }) => {
  const [code, setCode] = useState('');
  const [status, setStatus] = useState<AuthStatusResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void getAuthStatus().then(result => { if (active) setStatus(result); });
    return () => { active = false; };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (isSubmitting) return;
    if (status?.authenticated) return onEnter();
    setIsSubmitting(true);
    const result = await loginWithAccessCode(code);
    setStatus(result);
    setCode('');
    setIsSubmitting(false);
    if (result.authenticated) onEnter();
  };

  const isExpired = status?.status === 'ENTITLEMENT_EXPIRED';
  const showCode = status?.requiresCode && !status.authenticated && !isExpired;

  return (
    <div className="min-h-[100dvh] w-full bg-zinc-950 text-slate-200 flex flex-col items-center justify-start pt-12 pb-12 p-4 sm:p-8 font-sans selection:bg-emerald-500/30 overflow-y-auto">
      <div className="max-w-2xl w-full grid gap-8 animate-in fade-in slide-in-from-bottom-8 duration-700 pb-8">
        <div className="text-center space-y-3">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
            {APP_FULL_TITLE} <span className="text-emerald-400">(Bản {status?.entitlement.label || ACCESS_CONFIG.EDITION})</span>
          </h1>
          <p className="text-zinc-400 max-w-lg mx-auto">
            Hệ thống hỗ trợ dịch và biên tập truyện chuyên nghiệp bằng AI — Gói hỗ trợ {status?.entitlement.label || ACCESS_CONFIG.EDITION}.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-2 mt-4 text-zinc-400 font-medium">
            <span className="text-xs sm:text-sm bg-zinc-800/50 px-3 py-1.5 rounded-full border border-zinc-800">Công cụ được thiết kế bởi AI</span>
            <span className="text-xs sm:text-sm bg-zinc-800/50 px-3 py-1.5 rounded-full border border-zinc-800">Ý tưởng: Nguyễn Trí Hiếu</span>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 shadow-2xl shadow-black/50">
          <div className="w-full flex flex-col items-center justify-center gap-5">
            {!status ? (
              <div className="flex items-center gap-3 text-zinc-400 py-4"><Loader2 className="w-5 h-5 animate-spin" /> Đang kiểm tra phiên máy chủ...</div>
            ) : (
              <>
                {showCode && status.status !== 'AUTH_NOT_CONFIGURED' && status.status !== 'RATE_LIMITED' && (
                  <label className="w-full space-y-2">
                    <span className="text-sm font-semibold text-zinc-300 flex items-center gap-2"><KeyRound className="w-4 h-4" /> Mã truy cập</span>
                    <input
                      type="password"
                      autoComplete="current-password"
                      value={code}
                      maxLength={256}
                      onChange={event => setCode(event.target.value)}
                      className="w-full rounded-xl border border-zinc-700 bg-zinc-950 px-4 py-3 text-white outline-none focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20"
                      aria-label="Mã truy cập"
                      required
                    />
                  </label>
                )}
                {(status.authenticated || (showCode && !['AUTH_NOT_CONFIGURED', 'RATE_LIMITED'].includes(status.status))) && (
                  <button
                    type="submit"
                    disabled={isSubmitting || (!status.authenticated && !code)}
                    className="w-full group relative flex items-center justify-center gap-3 px-8 py-4 bg-white text-zinc-950 hover:bg-zinc-100 disabled:opacity-50 disabled:hover:scale-100 rounded-xl font-bold text-lg transition-all hover:scale-[1.02] active:scale-[0.98] shrink-0"
                  >
                    {isSubmitting ? <Loader2 className="w-5 h-5 animate-spin" /> : status.authenticated ? 'Tiếp tục vào ứng dụng' : 'Đăng nhập'}
                    {!isSubmitting && <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />}
                  </button>
                )}
                {!status.authenticated && safeMessage(status.status) && (
                  <div className={`text-sm font-medium p-4 rounded-xl text-center w-full ${isExpired ? 'bg-rose-500/10 border border-rose-500/20 text-rose-300' : 'bg-amber-500/10 border border-amber-500/20 text-amber-200'}`}>
                    {safeMessage(status.status)}
                  </div>
                )}
              </>
            )}
          </div>
        </form>

        {/* Donate Card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-3xl p-6 sm:p-8 space-y-6 shadow-2xl shadow-black/50">
          <div className="flex flex-col items-center text-center space-y-2">
            {/* Coffee Icon */}
            <div className="w-14 h-14 shrink-0 bg-amber-500/10 rounded-2xl flex items-center justify-center border border-amber-500/20 mb-2">
              <Coffee className="w-7 h-7 text-amber-500" />
            </div>

            <h3 className="text-xl font-semibold text-zinc-100 pt-2">
              Donate (Ủng hộ tác giả)
            </h3>
            <p className="text-sm text-zinc-400 leading-relaxed max-w-sm">
              Nếu bạn thấy bộ công cụ này hữu ích, hãy mời mình một cốc cà phê để mình có thêm động lực duy trì và phát triển nhé. Cảm ơn tấm lòng của bạn!
            </p>
          </div>
          
          <div className="flex flex-col items-center gap-6 py-6 bg-zinc-950/50 rounded-2xl border border-zinc-800/50 shadow-inner">
            <div className="text-center space-y-1.5">
              <p className="text-xs font-semibold text-zinc-500 uppercase tracking-widest">Ngân Hàng Vietcombank</p>
              <p className="text-lg font-bold text-zinc-100 uppercase tracking-tight">NGUYEN TRI HIEU</p>
              <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-emerald-500/10 rounded-full border border-emerald-500/20 mt-1">
                <span className="text-lg font-mono text-emerald-400 font-bold tracking-wider">1024391585</span>
              </div>
            </div>

            <div className="bg-white p-4 rounded-3xl shadow-2xl shadow-emerald-500/10 transform transition hover:scale-[1.02] duration-300">
              <div className="relative group">
                <img 
                  src="https://img.vietqr.io/image/970436-1024391585-compact2.png" 
                  alt="VietQR Donate" 
                  className="w-56 h-56 object-contain rounded-xl"
                  onError={(e) => {
                    (e.target as HTMLImageElement).src = 'https://img.vietqr.io/image/vietcombank-1024391585-compact2.png';
                  }}
                />
                <div className="absolute inset-0 border-4 border-white rounded-xl pointer-events-none"></div>
              </div>
            </div>
            
            <p className="text-xs text-zinc-600 font-medium tracking-widest">QUÉT MÃ ĐỂ CHUYỂN KHOẢN</p>
            
            {/* Telegram Contact Info */}
            <div className="flex flex-col items-center text-center space-y-1.5 pt-4 border-t border-zinc-800 w-full px-4">
              <p className="text-sm text-zinc-300">
                Inb liên hệ tham gia nhóm donate để nhận link cập nhật tính năng và model mới nhất.
              </p>
              <p className="text-sm text-zinc-400 mt-1">Vui lòng liên hệ:</p>
              <div className="space-y-1">
                <p className="text-sm text-zinc-300">Telegram cá nhân: <a href="https://t.me/trihieu259" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 hover:underline">t.me/trihieu259</a></p>
                <p className="text-sm text-zinc-300">Group hóng chuyện: <br/><a href="https://t.me/+3LW9SPLc9zMwNDdl" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:text-emerald-300 hover:underline">t.me/+3LW9SPLc9zMwNDdl</a></p>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
};
