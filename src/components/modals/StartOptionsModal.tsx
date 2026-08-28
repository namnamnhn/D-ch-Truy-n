import React, { useState, useEffect } from 'react';
import { Play, Sparkles, Zap, Activity, Layers, AlertTriangle } from 'lucide-react';
import { TranslationTier } from '../../types';
import { IS_LITE } from '../../constants';

// SHARED SUBCOMPONENT (đề xuất cải thiện fix11/fix12 - trích phần lặp lại NGUYÊN VĂN 2 lần trong
// chính file này, khối nút chọn tier vệ tinh DeepSeek): khoá nút + cảnh báo khi chưa
// cấu hình API Key. Chỉ trích trong phạm vi file này (không gộp chung với nút tương tự ở
// ModalManager.tsx retranslate - kiểu dáng/kích thước nút ở đó nhỏ gọn khác hẳn, gộp chung sẽ
// buộc phải đổi 1 trong 2 UI, rủi ro hồi quy không cần thiết cho lượt refactor nhỏ này).
interface SatelliteTierButtonProps {
    label: string;
    description: string;
    hasKey: boolean;
    isSelected: boolean;
    colorClass: { hoverBorder: string; selectedBg: string; selectedBorder: string; selectedRing: string; iconBg: string; iconText: string; iconBgHover: string; titleText: string };
    onSelect: () => void;
}
const SatelliteTierButton: React.FC<SatelliteTierButtonProps> = ({ label, description, hasKey, isSelected, colorClass, onSelect }) => (
    <button
        onClick={() => hasKey && onSelect()}
        disabled={!hasKey}
        title={!hasKey ? `Chưa cấu hình API Key ${label} trong Cài đặt` : undefined}
        className={`w-full p-4 rounded-2xl flex items-start gap-4 transition-all group text-left border ${!hasKey ? 'opacity-50 cursor-not-allowed bg-slate-50 border-slate-200' : isSelected ? `${colorClass.selectedBg} ${colorClass.selectedBorder} ring-2 ${colorClass.selectedRing} shadow-md` : `bg-white border-slate-200 ${colorClass.hoverBorder}`}`}
    >
        <div className={`p-3 rounded-xl shadow-sm transition-colors ${isSelected && hasKey ? colorClass.iconBg : `${colorClass.iconText} ${colorClass.iconBgHover}`}`}><Zap className="w-6 h-6" /></div>
        <div>
            <h4 className={`font-bold text-sm ${isSelected && hasKey ? colorClass.titleText : 'text-slate-700'}`}>{label}</h4>
            <p className="text-xs text-slate-500">{description}</p>
            {!hasKey && <p className="text-xs text-rose-500 font-semibold mt-1 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> Chưa cấu hình API Key — vào Cài đặt để thêm trước.</p>}
        </div>
    </button>
);

export interface StartOptionsModalProps {
    isOpen: boolean; onClose: () => void; onConfirm: (tier: TranslationTier) => void; isSmartMode?: boolean;
    // FIX (đề xuất - kiểm tra lại toàn bộ quy trình dịch/cứu hộ): trước đây modal này không hề
    // biết DeepSeek đã có Key hay chưa, dù dòng mô tả nút DeepSeek đã ghi rõ
    // "Chỉ khả dụng khi cấu hình API Key" — người dùng vẫn có thể chọn + bấm "Bắt Đầu" với tier
    // đó dù chưa dán Key nào, rồi mới nhận lỗi khó hiểu ở tầng API thay vì được cảnh báo ngay từ
    // đầu. Truyền cờ này để khoá + cảnh báo rõ ràng trước khi người dùng lỡ chọn nhầm.
    hasDeepSeekKey?: boolean;
}
export const StartOptionsModal: React.FC<StartOptionsModalProps> = ({ isOpen, onClose, onConfirm, isSmartMode, hasDeepSeekKey }) => {
    // Bản Lite chỉ còn Flash/Lite/DeepSeek -> mặc định chọn Flash (yêu cầu người dùng);
    // bản Full giữ mặc định 'normal' như cũ.
    const [selectedTier, setSelectedTier] = useState<TranslationTier>(IS_LITE ? 'flash' : 'normal');

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (isOpen) setSelectedTier(prev => {
            if (IS_LITE) return (prev !== 'flash' && prev !== 'lite' && prev !== 'deepseek') ? 'flash' : prev;
            return prev !== 'normal' ? 'normal' : prev;
        });
    }, [isOpen]);

    if (!isOpen) return null;
    // Chặn xác nhận nếu lỡ chọn đúng tier vệ tinh nhưng chưa có Key tương ứng (phòng hờ - về lý
    // thuyết nút đã bị disable nên không click được, nhưng vẫn chặn ở đây cho chắc).
    const isConfirmBlocked = selectedTier === 'deepseek' && !hasDeepSeekKey;
    return (
        <div className="fixed inset-0 z-[160] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
                <div className="p-6 overflow-y-auto flex-1">
                    <h3 className="text-xl font-bold text-slate-800 mb-4 flex items-center gap-2 flex-shrink-0">
                        {isSmartMode ? <Sparkles className="w-6 h-6 text-indigo-500" /> : <div className="text-sky-500"><Zap className="w-6 h-6" /></div>}
                        {isSmartMode ? "Smart AI Auto-Fix" : "Chọn Cấp Độ Dịch"}
                    </h3>
                    <div className="space-y-3">
                        <SatelliteTierButton
                            label="DeepSeek"
                            description="Dùng API DeepSeek. Chỉ khả dụng khi cấu hình API Key và chọn Model trong cài đặt DeepSeek."
                            hasKey={!!hasDeepSeekKey}
                            isSelected={selectedTier === 'deepseek'}
                            onSelect={() => setSelectedTier('deepseek')}
                            colorClass={{ hoverBorder: 'hover:border-teal-200', selectedBg: 'bg-teal-50', selectedBorder: 'border-teal-300', selectedRing: 'ring-teal-200', iconBg: 'bg-teal-500 text-white', iconText: 'bg-teal-50 text-teal-600', iconBgHover: 'group-hover:bg-teal-100', titleText: 'text-teal-800' }}
                        />
                        <button onClick={() => setSelectedTier('lite')} className={`w-full p-4 rounded-2xl flex items-start gap-4 transition-all group text-left border ${selectedTier === 'lite' ? 'bg-yellow-50 border-yellow-300 ring-2 ring-yellow-200 shadow-md' : 'bg-white border-slate-200 hover:border-yellow-200'}`}>
                            <div className={`p-3 rounded-xl shadow-sm transition-colors ${selectedTier === 'lite' ? 'bg-yellow-500 text-white' : 'bg-yellow-50 text-yellow-600 group-hover:bg-yellow-100'}`}><Zap className="w-6 h-6" /></div>
                            <div><h4 className={`font-bold text-sm ${selectedTier === 'lite' ? 'text-yellow-800' : 'text-slate-700'}`}>Lite Mode</h4><p className="text-xs text-slate-500">Chỉ dùng model 3.1 Flash Lite với tốc độ cao. Dừng tự động khi cạn Quota. Phù hợp cho dịch nội dung nhẹ.</p></div>
                        </button>
                        <button onClick={() => setSelectedTier('flash')} className={`w-full p-4 rounded-2xl flex items-start gap-4 transition-all group text-left border ${selectedTier === 'flash' ? 'bg-sky-50 border-sky-300 ring-2 ring-sky-200 shadow-md' : 'bg-white border-slate-200 hover:border-sky-200'}`}>
                            <div className={`p-3 rounded-xl shadow-sm transition-colors ${selectedTier === 'flash' ? 'bg-sky-500 text-white' : 'bg-sky-50 text-sky-500 group-hover:bg-sky-100'}`}><Zap className="w-6 h-6" /></div>
                            <div><h4 className={`font-bold text-sm ${selectedTier === 'flash' ? 'text-sky-800' : 'text-slate-700'}`}>Flash Mode</h4><p className="text-xs text-slate-500">Tốc độ tối đa, tiết kiệm Pro.</p></div>
                        </button>
                        {!IS_LITE && (<button onClick={() => setSelectedTier('normal')} className={`w-full p-4 rounded-2xl flex items-start gap-4 transition-all group text-left border ${selectedTier === 'normal' ? 'bg-indigo-50 border-indigo-300 ring-2 ring-indigo-200 shadow-md' : 'bg-white border-slate-200 hover:border-indigo-200'}`}>
                            <div className={`p-3 rounded-xl shadow-sm transition-colors ${selectedTier === 'normal' ? 'bg-indigo-500 text-white' : 'bg-indigo-50 text-indigo-500 group-hover:bg-indigo-100'}`}><Activity className="w-6 h-6" /></div>
                            <div><h4 className={`font-bold text-sm ${selectedTier === 'normal' ? 'text-indigo-800' : 'text-slate-700'}`}>Normal Mode (Khuyên dùng)</h4><p className="text-xs text-slate-500">Dịch bằng Pro Model (3 luồng, phân bổ thông minh quanh giới hạn RPM của Pro), tối ưu quota.</p></div>
                        </button>)}
                        {!IS_LITE && (<button onClick={() => setSelectedTier('pro')} className={`w-full p-4 rounded-2xl flex items-start gap-4 transition-all group text-left border ${selectedTier === 'pro' ? 'bg-purple-50 border-purple-300 ring-2 ring-purple-200 shadow-md' : 'bg-white border-slate-200 hover:border-purple-200'}`}>
                            <div className={`p-3 rounded-xl shadow-sm transition-colors ${selectedTier === 'pro' ? 'bg-purple-500 text-white' : 'bg-purple-50 text-purple-500 group-hover:bg-purple-100'}`}><Sparkles className="w-6 h-6" /></div>
                            <div><h4 className={`font-bold text-sm ${selectedTier === 'pro' ? 'text-purple-800' : 'text-slate-700'}`}>Pro Mode</h4><p className="text-xs text-slate-500">Chất lượng cao nhất, tuân thủ nghiêm ngặt.</p></div>
                        </button>)}
                        {!IS_LITE && (<button onClick={() => setSelectedTier('full')} className={`w-full p-4 rounded-2xl flex items-start gap-4 transition-all group text-left border ${selectedTier === 'full' ? 'bg-emerald-50 border-emerald-300 ring-2 ring-emerald-200 shadow-md' : 'bg-white border-slate-200 hover:border-emerald-200'}`}>
                            <div className={`p-3 rounded-xl shadow-sm transition-colors ${selectedTier === 'full' ? 'bg-emerald-500 text-white' : 'bg-emerald-50 text-emerald-500 group-hover:bg-emerald-100'}`}><Layers className="w-6 h-6" /></div>
                            <div><h4 className={`font-bold text-sm ${selectedTier === 'full' ? 'text-emerald-800' : 'text-slate-700'}`}>Full Mode</h4><p className="text-xs text-slate-500">Dịch bằng Pro (3 luồng), dự phòng Flash. Auto Fix bằng Flash.</p></div>
                        </button>)}
                    </div>
                </div>
                <div className="p-4 bg-slate-50 border-t border-slate-200 flex justify-end gap-3 flex-shrink-0">
                    <button onClick={onClose} className="px-6 py-2 text-sm font-bold text-slate-500 hover:text-slate-700">Hủy</button>
                    <button onClick={() => onConfirm(selectedTier)} disabled={isConfirmBlocked} title={isConfirmBlocked ? "Chưa cấu hình API Key cho tier đang chọn" : undefined} className="px-8 py-2 bg-gradient-to-r from-indigo-500 to-sky-500 text-white rounded-xl font-bold text-sm shadow-lg shadow-indigo-200/50 hover:shadow-indigo-200/80 transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none">
                        <Play className="w-4 h-4 fill-current" /> Bắt Đầu
                    </button>
                </div>
            </div>
        </div>
    );
};
