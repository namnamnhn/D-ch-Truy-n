/* eslint-disable react-hooks/set-state-in-effect */
import React, { useState, useEffect } from 'react';
import { Settings, X, CheckCircle, AlertTriangle, Loader2, Save, ShieldCheck } from 'lucide-react';
import { runApiHealthCheck, ApiHealthResult } from '../../services/api/healthCheck';
import { TriageSettingsTab } from './tabs/TriageSettingsTab';
import { DeepSeekSettingsTab } from './tabs/DeepSeekSettingsTab';
import { DEFAULT_TRIAGE_DELAYS } from './tabs/apiSettingsShared';
import { IS_LITE } from '../../constants';
import { setUserGeminiKeys, getUserGeminiKeysRaw, consumePendingGeminiKeyTab } from '../../services/api/gemini';

interface ApiSettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    deepseekKey: string;
    setDeepseekKey: (v: string) => void;
    deepseekModel: string;
    setDeepseekModel: (v: string) => void;
    // Đề xuất cải thiện tồn đọng: cho tinh chỉnh các khoảng nghỉ giữa lô hậu kiểm khởi động
    // (trước đây cố định cứng trong code). Optional để không bắt buộc mọi nơi gọi modal này
    // phải truyền - nếu thiếu, dùng giá trị mặc định y hệt hành vi cũ.
    triageDelays?: { staggerDelayMs: number; recoveryBatchDelayMs: number; diagnosisBatchDelayMs: number };
    setTriageDelays?: (v: Partial<{ staggerDelayMs: number; recoveryBatchDelayMs: number; diagnosisBatchDelayMs: number }>) => void;
}

export const ApiSettingsModal: React.FC<ApiSettingsModalProps> = ({
    isOpen, onClose,
    deepseekKey, setDeepseekKey, deepseekModel, setDeepseekModel,
    triageDelays, setTriageDelays
}) => {
    const effectiveTriageDelays = triageDelays || DEFAULT_TRIAGE_DELAYS;
    const [activeTab, setActiveTab] = useState<'deepseek' | 'triage' | 'gemini'>('deepseek');
    // FIX59 (Lite): mở modal do thiếu key (event từ ensureGeminiKeyForLite) -> nhảy sẵn tab Gemini
    useEffect(() => {
        if (isOpen && consumePendingGeminiKeyTab()) setActiveTab('gemini');
    }, [isOpen]);
    const [localGeminiKeys, setLocalGeminiKeys] = useState<string>(() => getUserGeminiKeysRaw());

    // --- DEEPSEEK: state riêng ---
    const [localDsKey, setLocalDsKey] = useState(deepseekKey);
    const [localDsModels, setLocalDsModels] = useState<string[]>([]);

    useEffect(() => {
        if (isOpen) {
            setLocalDsKey(deepseekKey);
            const m = deepseekModel ? deepseekModel.split(',').map(s => s.trim()).filter(Boolean) : ['deepseek-v4-flash'];
            setLocalDsModels(m.length > 0 ? m : ['deepseek-v4-flash']);
        }
    }, [isOpen, deepseekKey, deepseekModel]);

    const handleSave = () => {
        setDeepseekKey(localDsKey);
        setDeepseekModel(localDsModels.join(','));
        onClose();
    };

    // NÂNG CẤP #9 — Health-check thống nhất các nhà cung cấp trong 1 lần bấm.
    const [healthResults, setHealthResults] = useState<ApiHealthResult[] | null>(null);
    const [isHealthChecking, setIsHealthChecking] = useState(false);

    const handleRunHealthCheck = async () => {
        setIsHealthChecking(true);
        setHealthResults(null);
        try {
            const results = await runApiHealthCheck({
                enabledModels: [],
                deepseekKeys: localDsKey,
                deepseekModel: localDsModels[0],
            });
            setHealthResults(results);
        } finally {
            setIsHealthChecking(false);
        }
    };

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-white dark:bg-slate-900 rounded-3xl shadow-elevation-5 w-full max-w-4xl overflow-hidden animate-in zoom-in-95 duration-200 border border-slate-200 dark:border-slate-800 flex flex-col max-h-[90vh]">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-100 dark:border-slate-800 flex-shrink-0">
                    <h3 className="text-lg font-bold text-slate-800 dark:text-slate-100 flex items-center gap-2">
                        <Settings className="w-5 h-5 text-primary-500" />
                        Quản Lý API Key & Model
                    </h3>
                    <button aria-label="Đóng" onClick={onClose} className="p-2 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1">
                        <X className="w-5 h-5" />
                    </button>
                </div>

                {/* TAB BAR: DeepSeek / Hậu Kiểm */}
                <div className="flex items-center gap-6 px-6 border-b border-slate-100 dark:border-slate-800 flex-shrink-0">
                    <button
                        onClick={() => setActiveTab('deepseek')}
                        className={`py-3 text-sm font-bold border-b-2 transition-colors duration-200 ease-smooth flex items-center gap-2 ${activeTab === 'deepseek' ? 'border-teal-500 text-teal-600 dark:text-teal-400' : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                    >
                        DeepSeek
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-teal-50 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400">CỨU HỘ</span>
                    </button>
                    <button
                        onClick={() => setActiveTab('triage')}
                        className={`py-3 text-sm font-bold border-b-2 transition-colors duration-200 ease-smooth ${activeTab === 'triage' ? 'border-amber-500 text-amber-600 dark:text-amber-400' : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                    >
                        Hậu Kiểm Khởi Động
                    </button>
                    {IS_LITE && (
                    <button
                        onClick={() => setActiveTab('gemini')}
                        className={`py-3 text-sm font-bold border-b-2 transition-colors duration-200 ease-smooth ${activeTab === 'gemini' ? 'border-sky-500 text-sky-600 dark:text-sky-400' : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'}`}
                    >
                        API Key Gemini
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-sky-50 dark:bg-sky-900/30 text-sky-600 dark:text-sky-400">BẮT BUỘC</span>
                    </button>
                    )}
                </div>

                {IS_LITE && activeTab === 'gemini' && (
                    <div className="px-6 py-5 space-y-3 overflow-y-auto">
                        <p className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">API Key Gemini Cá Nhân (bản Lite)</p>
                        <p className="text-[11px] text-slate-400">
                            Dán 1 hoặc nhiều key (mỗi key một dòng, hoặc cách nhau bằng dấu phẩy). App tự luân phiên các key.
                            Key chỉ lưu trong phiên làm việc trên trình duyệt này — không lưu vào bộ nhớ máy, không đi kèm file Backup.
                            Lấy key miễn phí tại{' '}
                            <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="font-bold text-sky-600 hover:underline">aistudio.google.com/apikey</a>.
                        </p>
                        <textarea
                            className="w-full h-28 p-3 text-sm font-mono bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:ring-2 focus:ring-sky-400 resize-none custom-scrollbar"
                            placeholder={'AIza...\nAIza...'}
                            value={localGeminiKeys}
                            onChange={e => { setLocalGeminiKeys(e.target.value); setUserGeminiKeys(e.target.value); }}
                        />
                        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="inline-block px-4 py-2 bg-sky-50 dark:bg-sky-900/20 text-sky-600 dark:text-sky-300 border border-sky-200 dark:border-sky-800 rounded-xl text-xs font-bold hover:bg-sky-100 transition-colors">🔑 Lấy API Key Gemini miễn phí</a>
                    </div>
                )}

                <TriageSettingsTab
                    active={activeTab === 'triage'}
                    delays={effectiveTriageDelays}
                    onChange={(v) => setTriageDelays?.(v)}
                />
                <DeepSeekSettingsTab
                    active={activeTab === 'deepseek'}
                    localDsKey={localDsKey}
                    setLocalDsKey={setLocalDsKey}
                    localDsModels={localDsModels}
                    setLocalDsModels={setLocalDsModels}
                    deepseekKey={deepseekKey}
                    setDeepseekKey={setDeepseekKey}
                />

                {/* NÂNG CẤP #9 — Chẩn đoán nhanh tất cả nhà cung cấp */}
                <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                        <div>
                            <p className="text-xs font-bold text-slate-600 dark:text-slate-300 uppercase tracking-wider">Chẩn Đoán API</p>
                            <p className="text-[11px] text-slate-400">Kiểm tra nhanh Gemini + từng key DeepSeek đang nhập</p>
                        </div>
                        <button onClick={handleRunHealthCheck} disabled={isHealthChecking} className="px-4 py-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 rounded-xl text-sm font-bold hover:bg-emerald-100 dark:hover:bg-emerald-900/40 transition-colors duration-200 ease-smooth flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1 disabled:opacity-50">
                            {isHealthChecking ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                            {isHealthChecking ? 'Đang kiểm tra...' : 'Kiểm tra kết nối'}
                        </button>
                    </div>
                    {healthResults && (
                        <div className="mt-3 space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar pr-1">
                            {healthResults.map((r, idx) => (
                                <div key={idx} className={`flex items-center justify-between gap-3 px-3 py-2 rounded-lg border text-xs ${r.ok ? 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-900' : 'bg-rose-50 dark:bg-rose-900/10 border-rose-100 dark:border-rose-900'}`}>
                                    <div className="flex items-center gap-2 min-w-0">
                                        {r.ok ? <CheckCircle className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
                                        <span className="font-bold text-slate-700 dark:text-slate-200 truncate">{r.name}</span>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        <span className={`truncate max-w-[220px] ${r.ok ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'}`}>{r.detail}</span>
                                        {r.latencyMs > 0 && <span className="text-slate-400">{r.latencyMs}ms</span>}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </div>

                <div className="px-6 py-4 border-t border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/50 flex justify-between flex-shrink-0">
                    <button onClick={onClose} className="px-6 py-2 text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800 rounded-xl text-sm font-medium transition-colors duration-200 ease-smooth focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1">
                        Đóng
                    </button>
                    <button onClick={handleSave} className="px-6 py-2 bg-primary-600 hover:bg-primary-700 text-white rounded-xl text-sm font-bold shadow-elevation-2 hover:shadow-elevation-3 transition-all duration-200 ease-smooth flex items-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-400 focus-visible:ring-offset-1">
                        <Save className="w-4 h-4" /> Lưu Cấu Hình
                    </button>
                </div>
            </div>
        </div>
    );
};
