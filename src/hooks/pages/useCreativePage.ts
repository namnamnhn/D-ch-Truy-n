import { useState, useRef, useEffect } from 'react';
import { getAiClient, smartExecution, SAFETY_SETTINGS } from '../../services/api/gemini';
import { CreativeState, Character, CreativeSnapshot } from '../../types';
import { IS_LITE } from '../../constants';
import {
    runStoryEnginePipeline,
    compileStoryControl,
    StoryBible,
    PipelineProgressInfo
} from '../../services/storyEngine';

export type EngineProgressInfo = PipelineProgressInfo;

// Giữ tối đa 20 snapshot gần nhất (mỗi lượt "Viết Tiếp" chụp 1 bản trước khi áp dụng chương mới)
const CREATIVE_SNAPSHOT_LIMIT = 20;
import { parseEpub, downloadTextFile } from '../../utils/fileHelpers';
import { applySetupImport, parseSetupFileContent } from '../../services/storyEngine/setupImport';

export const parseSetupFile = parseSetupFileContent;

export interface UseCreativePageProps {
    addToast: (msg: string, type?: 'success' | 'error' | 'info' | 'warning') => void;
    state: CreativeState;
    setState: React.Dispatch<React.SetStateAction<CreativeState>>;
    setStoryInfoSafe?: (info: any) => void;
    storyInfo?: any;
    files?: any[];
    setFilesSafe?: (action: React.SetStateAction<any[]>) => void;
    setCoverImage?: (file: File | null) => void;
    setStartTime?: (v: number | null) => void;
    setEndTime?: (v: number | null) => void;
    addLog?: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export const useCreativePage = ({
    addToast, state, setState, setStoryInfoSafe, storyInfo, files, setFilesSafe, setCoverImage, setStartTime, setEndTime, addLog
}: UseCreativePageProps) => {
    const [currentStep, setCurrentStep] = useState(1);
    const [mode, setMode] = useState<'new' | 'continue'>('new');
    const [isAnalyzing, setIsAnalyzing] = useState(false);
    const [userPrompt, setUserPrompt] = useState('');
    const fileInputRef = useRef<HTMLInputElement>(null);
    const setupFileInputRef = useRef<HTMLInputElement>(null);
    const chaptersEndRef = useRef<HTMLDivElement>(null);
    
    const [isGenerating, setIsGenerating] = useState(false);
    const [engineProgress, setEngineProgress] = useState<EngineProgressInfo | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    const handleStopGenerating = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
        }
    };

    const [editingCharId, setEditingCharId] = useState<string | null>(null);
    const [charForm, setCharForm] = useState<Partial<Character>>({});

    const handleSaveChar = () => {
        if (!charForm.name) {
            addToast('Tên nhân vật không được để trống!', 'warning');
            return;
        }
        setState(prev => {
            const characters = prev.characters || [];
            if (editingCharId) {
                return { ...prev, characters: characters.map(c => c.id === editingCharId ? { ...c, ...charForm } as Character : c) };
            } else {
                return { ...prev, characters: [...characters, { ...charForm, id: 'char_' + Date.now() } as Character] };
            }
        });
        setEditingCharId(null);
        setCharForm({});
    };

    const handleEditChar = (c: Character) => {
        setEditingCharId(c.id);
        setCharForm(c);
    };

    const handleDeleteChar = (id: string) => {
        if (confirm('Bạn có chắc muốn xóa nhân vật này?')) {
            setState(prev => ({ ...prev, characters: (prev.characters || []).filter(c => c.id !== id) }));
        }
    };

    const setup = state?.setup || {};
    const setSetup = (patch: any) => setState(prev => ({ ...prev, setup: { ...(prev?.setup || {}), ...patch } }));

    const seedTitle = setup.seedTitle || '';
    const premise = setup.premise || '';
    const worldNotes = setup.worldNotes || '';
    const charNotes = setup.charNotes || '';
    const outline = setup.outline || '';
    const genre = setup.genre || 'Tiên Hiệp';

    // Auto-migrate premise if seriesPremise or continuitySummary are not set
    useEffect(() => {
        if (premise && (!state.seriesPremise || !state.continuitySummary)) {
            setState(prev => ({
                ...prev,
                seriesPremise: prev.seriesPremise || premise,
                continuitySummary: prev.continuitySummary || premise,
                targetChapters: prev.targetChapters || 2
            }));
        }
    }, [premise]);

    useEffect(() => {
        if (state?.chapters?.length > 0 && currentStep === 5) {
            chaptersEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [state?.chapters, currentStep]);

    const handleAnalyzeNew = async () => {
        if (!userPrompt.trim()) {
            addToast('Vui lòng nhập ý tưởng của bạn!', 'error');
            return;
        }
        setIsAnalyzing(true);
        addLog?.('Bắt đầu phân tích ý tưởng...', 'info');
        try {
            const ai = getAiClient();
            const res = await smartExecution(
                ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'],
                async (modelId) => {
                    const r = await ai.models.generateContent({
                        model: modelId,
                        contents: `Bạn là chuyên gia thiết kế cốt truyện tiên hiệp/đô thị/khoa huyễn. 
Dựa vào ý tưởng sau của người dùng: "${userPrompt}"
Hãy phát triển và điền vào các mục sau. Trả về đúng định dạng JSON, không có code block markdown:
{
  "title": "Tên truyện đề xuất",
  "genre": "Thể loại chính (Tiên Hiệp, Huyền Huyễn, Đô Thị...)",
  "premise": "Tóm tắt ý tưởng cốt truyện (Premise)",
  "worldNotes": "Bối cảnh thế giới/Hệ thống tu luyện",
  "charNotes": "Ghi chú nhân vật chung",
  "characters": [
    { "name": "Tên", "gender": "Nam/Nữ", "age": "Tuổi", "role": "Vai trò", "appearance": "Ngoại hình", "personality": "Tính cách" }
  ],
  "outline": "Dàn ý cơ bản (Từ khởi đầu đến đỉnh cao)"
}`,
                        config: { safetySettings: SAFETY_SETTINGS, temperature: 0.7 }
                    });
                    return r.text || '';
                },
                'Phân tích ý tưởng mới', addLog
            );

            const jsonStr = res.replace(/```json/g, '').replace(/```/g, '').trim();
            const data = JSON.parse(jsonStr);

            setSetup({
                seedTitle: data.title || '',
                genre: data.genre || genre,
                premise: data.premise || '',
                worldNotes: data.worldNotes || '',
                charNotes: data.charNotes || '',
                outline: data.outline || ''
            });

            setState(prev => ({
                ...prev,
                seriesPremise: data.premise || '',
                continuitySummary: data.premise || '',
                characters: Array.isArray(data.characters) ? data.characters.map((c: any) => ({ ...c, id: 'char_' + Date.now() + '_' + Math.random() })) : prev.characters
            }));

            if (setStoryInfoSafe && storyInfo) {
                setStoryInfoSafe({ ...storyInfo, title: data.title || storyInfo.title });
            }

            addToast('Phân tích thành công! Đã tự động điền các trang thiết lập.', 'success');
            setCurrentStep(2);
        } catch (e: any) {
            addToast('Lỗi phân tích: ' + e.message, 'error');
        } finally {
            setIsAnalyzing(false);
        }
    };

    const handleEpubUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setIsAnalyzing(true);
        addLog?.('Bắt đầu đọc và phân tích EPUB (3.5 Flash)...', 'info');
        try {
            const parsed = await parseEpub(file);
            if (setFilesSafe && parsed.files.length > 0) {
                const mappedFiles = parsed.files.map(f => ({ ...f, translatedContent: f.content, status: 'completed' as any }));
                setFilesSafe(mappedFiles);
            }
            if (setCoverImage && parsed.coverBlob) {
                const ext = parsed.coverBlob.type.split('/')[1] || 'jpg';
                setCoverImage(new File([parsed.coverBlob], `cover.${ext}`, { type: parsed.coverBlob.type }));
            }
            if (setStoryInfoSafe && storyInfo) {
                setStoryInfoSafe({ ...storyInfo, title: parsed.info.title || storyInfo.title, author: parsed.info.author || storyInfo.author });
            }

            const textContent = parsed.files.map(f => f.content).join('\n\n').substring(0, 100000);

            const ai = getAiClient();
            const response = await smartExecution(
                ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.0-flash'],
                async (modelId) => {
                    const r = await ai.models.generateContent({
                        model: modelId,
                        contents: `Bạn là biên tập văn học. Đọc nội dung truyện sau. Hãy tóm tắt và trích xuất thông tin để chuẩn bị viết tiếp.
Trả về định dạng JSON (không có markdown):
{
  "genre": "Thể loại theo đánh giá của bạn (Tiên hiệp, kỳ ảo, hiện đại...)",
  "premise": "Tóm tắt mạch truyện tới thời điểm hiện tại.",
  "worldNotes": "Hệ thống tu luyện, bối cảnh thế giới hiện có.",
  "charNotes": "Ghi chú nhân vật chung",
  "characters": [
    { "name": "Tên", "gender": "Nam/Nữ", "age": "Tuổi", "role": "Vai trò", "appearance": "Ngoại hình", "personality": "Tính cách" }
  ],
  "outline": "Dàn ý dự kiến cho các chương tiếp theo để viết tiếp."
}

Nội dung:
${textContent}`,
                        config: { safetySettings: SAFETY_SETTINGS, temperature: 0.5 }
                    });
                    return r.text || '';
                },
                'Phân tích EPUB', addLog
            );

            const jsonStr = response.replace(/```json/g, '').replace(/```/g, '').trim();
            const data = JSON.parse(jsonStr);

            setSetup({
                seedTitle: parsed.info.title || '',
                genre: data.genre || genre,
                premise: data.premise || '',
                worldNotes: data.worldNotes || '',
                charNotes: data.charNotes || '',
                outline: data.outline || ''
            });

            setState(prev => ({
                ...prev,
                seriesPremise: data.premise || '',
                continuitySummary: data.premise || '',
                characters: Array.isArray(data.characters) ? data.characters.map((c: any) => ({ ...c, id: 'char_' + Date.now() + '_' + Math.random() })) : prev.characters
            }));

            addToast('Nhập dữ liệu và phân tích thành công!', 'success');
            setCurrentStep(2);
        } catch (error: any) {
            addToast('Lỗi xử lý file EPUB: ' + error.message, 'error');
            addLog?.('Lỗi EPUB: ' + error.message, 'error');
        } finally {
            setIsAnalyzing(false);
            if (e.target) e.target.value = '';
        }
    };

    /**
     * Sanity Check: Biên dịch và kiểm tra cấu trúc Story Control mà không cần sinh text
     */
    const handleSanityCheckStoryEngine = async () => {
        setIsAnalyzing(true);
        addLog?.('[Story Engine] Đang kiểm tra Bible và biên dịch Story Control...', 'info');
        try {
            const ai = getAiClient();
            const bible: StoryBible = {
                seedTitle: seedTitle || storyInfo?.title || 'Tác phẩm mới',
                genre: genre || 'Tiên Hiệp',
                seriesPremise: state.seriesPremise || premise || 'Chưa có tiền đề',
                continuitySummary: state.continuitySummary || premise || '',
                worldNotes: worldNotes || '',
                charNotes: charNotes || '',
                outline: outline || '',
                characters: state.characters || [],
                totalPlannedChapters: state.totalTargetChapters || 600,
                storyEngineSettingsV3: state.storyEngineSettingsV3,
                blueprintV3: state.blueprintV3
            };

            const compiled = await compileStoryControl(bible, async (prompt) => {
                return smartExecution(
                    ['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.0-flash'],
                    async (modelId) => {
                        const r = await ai.models.generateContent({
                            model: modelId,
                            contents: prompt,
                            config: { safetySettings: SAFETY_SETTINGS, temperature: 0.2 }
                        });
                        return r.text || '';
                    },
                    'Biên dịch Story Control', addLog
                );
            });

            setState(prev => ({ ...prev, storyControl: compiled }));
            addToast(`Story Engine sẵn sàng! Đã xác lập ${compiled.arcs.length} Arc, ${compiled.characterGates.length} Character Gate, ${compiled.spoilerGates.length} Spoiler Gate.`, 'success');
            addLog?.(`[Story Engine] Sẵn sàng cho 600 chương: ${compiled.arcs.map(a => `${a.title} (${a.startChapter}-${a.endChapter})`).join(' -> ')}`, 'success');
        } catch (err: any) {
            addToast(`Lỗi kiểm tra Story Engine: ${err.message}`, 'error');
            addLog?.(`[Story Engine] Lỗi: ${err.message}`, 'error');
        } finally {
            setIsAnalyzing(false);
        }
    };

    /**
     * Sáng tác chương mới với Long-Form Story Engine Pipeline V3
     */
    const handleGenerateCreativeChapters = async () => {
        setIsGenerating(true);
        setEngineProgress({ stage: 'planning', message: 'Khởi động Long-Form Story Engine V3...', progress: 5 });
        if (setStartTime) setStartTime(Date.now());
        addLog?.('Bắt đầu quy trình sáng tác Story Engine V3 (Arc Gating + Semantic QA Validator)...', 'info');

        const controller = new AbortController();
        abortControllerRef.current = controller;

        try {
            const ai = getAiClient();
            const batchSize = Math.max(1, Math.min(state.targetChapters || 2, 10));

            const bible: StoryBible = {
                seedTitle: seedTitle || storyInfo?.title || 'Tác phẩm mới',
                genre: genre || 'Tiên Hiệp',
                seriesPremise: state.seriesPremise || premise || 'Chưa có tiền đề',
                continuitySummary: state.continuitySummary || premise || '',
                worldNotes: worldNotes || '',
                charNotes: charNotes || '',
                outline: outline || '',
                characters: state.characters || [],
                totalPlannedChapters: state.totalTargetChapters || 600,
                storyEngineSettingsV3: state.storyEngineSettingsV3,
                blueprintV3: state.blueprintV3
            };

            // Chụp snapshot trạng thái trước khi thực thi
            const currentSnapshot: CreativeSnapshot = {
                id: 'snap_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                createdAt: Date.now(),
                chapterCountBefore: (state.chapters || []).length,
                chapters: state.chapters || [],
                characters: state.characters || [],
                premise: state.continuitySummary || premise,
                seriesPremise: state.seriesPremise || premise,
                continuitySummary: state.continuitySummary || premise,
                setup: { ...setup },
                storyControl: state.storyControl,
                storyState: state.storyState,
                memoryIndex: state.memoryIndex
            };

            const fastRunner = async (prompt: string, sys?: string) => {
                return smartExecution(
                    ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite'],
                    async (modelId) => {
                        const r = await ai.models.generateContent({
                            model: modelId,
                            contents: prompt,
                            config: {
                                systemInstruction: sys,
                                safetySettings: SAFETY_SETTINGS,
                                temperature: 0.3,
                                abortSignal: controller.signal
                            }
                        });
                        return r.text || '';
                    },
                    'Fast Engine Task', addLog
                );
            };

            const proCandidates = IS_LITE
                ? ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash']
                : ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash'];

            const proRunner = async (prompt: string, sys?: string) => {
                return smartExecution(
                    proCandidates,
                    async (modelId) => {
                        const r = await ai.models.generateContent({
                            model: modelId,
                            contents: prompt,
                            config: {
                                systemInstruction: sys,
                                safetySettings: SAFETY_SETTINGS,
                                temperature: 0.8,
                                maxOutputTokens: 65536,
                                abortSignal: controller.signal
                            }
                        });
                        return r.text || '';
                    },
                    'Pro Writer Task', addLog
                );
            };

            const result = await runStoryEnginePipeline({
                bible,
                existingControl: state.storyControl,
                existingState: state.storyState,
                existingMemories: state.memoryIndex || [],
                existingChapters: state.chapters || [],
                batchSize,
                aiFastRunner: fastRunner,
                aiProRunner: proRunner,
                onProgress: (info, progressPercent) => {
                    if (typeof info === 'string') {
                        setEngineProgress({
                            stage: 'planning',
                            message: info,
                            progress: typeof progressPercent === 'number' ? progressPercent : 10,
                            currentChapter: (state.chapters?.length || 0) + 1,
                            totalChapters: (state.chapters?.length || 0) + batchSize
                        });
                    } else if (info && typeof info === 'object') {
                        setEngineProgress({
                            stage: info.stage || 'planning',
                            message: info.message || 'Đang xử lý...',
                            progress: typeof info.progress === 'number' ? info.progress : 10,
                            currentChapter: info.currentChapter,
                            totalChapters: info.totalChapters,
                            retryCount: info.retryCount
                        });
                    }
                },
                onLog: (msg) => {
                    addLog?.(msg, msg.includes('CẢNH BÁO') ? 'error' : msg.includes('thành công') ? 'success' : 'info');
                }
            });

            if (!result.success) {
                addToast(result.errorMessage || 'Lượt viết không vượt qua hậu kiểm QA.', 'error');
                return;
            }

            const pushSnapshot = (prevSnapshots?: CreativeSnapshot[]) =>
                [...(prevSnapshots || []), currentSnapshot].slice(-CREATIVE_SNAPSHOT_LIMIT);

            // Cập nhật state chính thức khi QA Passed
            setState(prev => ({
                ...prev,
                chapters: [...(prev.chapters || []), ...result.acceptedChapters],
                characters: result.newCharacters,
                storyControl: result.nextControl,
                storyState: result.nextState,
                continuitySummary: result.updatedContinuitySummary,
                memoryIndex: [...(prev.memoryIndex || []), ...result.newMemories],
                lastValidationResult: result.validationResult,
                snapshots: pushSnapshot(prev.snapshots)
            }));

            // Đồng bộ lại continuitySummary vào setup.premise nếu cần hiển thị
            setSetup({ premise: result.updatedContinuitySummary });

            addToast(`Đã hoàn tất nghiệm thu & lưu ${result.acceptedChapters.length} chương mới! (QA Score: ${result.validationResult.continuityScore}/100)`, 'success');

        } catch (e: any) {
            const isAborted = e?.name === 'AbortError' || /abort/i.test(e?.message || '');
            if (isAborted) {
                addToast('Đã dừng sáng tác theo yêu cầu.', 'warning');
                addLog?.('Đã dừng sáng tác theo yêu cầu người dùng.', 'info');
            } else {
                addToast(`Lỗi sáng tác: ${e.message}`, 'error');
                addLog?.(`Lỗi pipeline: ${e.message}`, 'error');
            }
        } finally {
            abortControllerRef.current = null;
            setIsGenerating(false);
            setEngineProgress(null);
            if (setEndTime) setEndTime(Date.now());
        }
    };

    const handleExportSetup = () => {
        const characters = state.characters || [];
        const charText = characters.length > 0
            ? characters.map(c => `- ${c.name}${c.role ? ` (${c.role})` : ''}${c.gender ? `, ${c.gender}` : ''}${c.age ? `, ${c.age} tuổi` : ''}\n  Ngoại hình: ${c.appearance || '(chưa có)'}\n  Tính cách: ${c.personality || '(chưa có)'}`).join('\n\n')
            : '(Chưa có nhân vật nào)';

        const engineSettingsV3 = JSON.stringify({
            version: 'v3',
            seriesPremise: state.seriesPremise || premise,
            continuitySummary: state.continuitySummary || premise,
            ...(state.storyEngineSettingsV3 || {})
        }, null, 2);

        const blueprintV3 = state.blueprintV3
            ? JSON.stringify(state.blueprintV3.source, null, 2)
            : '';

        const content = [
            `THIẾT LẬP SÁNG TÁC: ${seedTitle || storyInfo?.title || '(Chưa đặt tên)'}`,
            `Xuất lúc: ${new Date().toLocaleString('vi-VN')}`,
            '='.repeat(60),
            '',
            `[THỂ LOẠI]\n${genre || '(Chưa chọn)'}`,
            '',
            `[TIỀN ĐỀ / TÓM TẮT]\n${state.seriesPremise || premise || '(Chưa có)'}`,
            '',
            `[THẾ GIỚI]\n${worldNotes || '(Chưa có)'}`,
            '',
            `[NHÂN VẬT]\n${charText}`,
            '',
            `[GHI CHÚ NHÂN VẬT KHÁC]\n${charNotes || '(Chưa có)'}`,
            '',
            `[DÀN Ý]\n${outline || '(Chưa có)'}`,
            '',
            `[STORY_ENGINE_SETTINGS_V3]\n${engineSettingsV3}`,
            blueprintV3 ? `\n[STORY_ENGINE_BLUEPRINT_V3]\n${blueprintV3}` : ''
        ].join('\n');
        const safeTitle = (seedTitle || storyInfo?.title || 'ThietLap').replace(/[\\/:*?"<>|]/g, '').trim() || 'ThietLap';
        downloadTextFile(`ThietLapSangTac_${safeTitle}.txt`, content);
        addToast('Đã xuất file thiết lập (.txt)', 'success');
    };

    const handleDownloadChapters = () => {
        const chapters = state.chapters || [];
        if (chapters.length === 0) {
            addToast('Chưa có chương nào để tải xuống.', 'warning');
            return;
        }
        const content = chapters.map(c => `${c.title}\n${'-'.repeat(40)}\n\n${c.content}`).join('\n\n\n');
        const safeTitle = (seedTitle || storyInfo?.title || 'SangTac').replace(/[\\/:*?"<>|]/g, '').trim() || 'SangTac';
        downloadTextFile(`${safeTitle}_${chapters.length}Chuong.txt`, content);
        addToast(`Đã tải xuống ${chapters.length} chương (.txt)`, 'success');
    };

    const handleImportSetup = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
            try {
                const text = String(ev.target?.result || '');
                const parsed = parseSetupFile(text);
                if (!parsed) {
                    addToast('Không đọc được nội dung file thiết lập.', 'error');
                    return;
                }
                const hasExisting = !!(seedTitle || premise || worldNotes || charNotes || outline
                    || (state.characters && state.characters.length > 0)
                    || (state.chapters && state.chapters.length > 0));
                if (hasExisting && !confirm('Đã có dữ liệu thiết lập hiện tại. Nhập file mới sẽ GHI ĐÈ toàn bộ. Bạn có chắc muốn tiếp tục?')) {
                    return;
                }
                setState(prev => applySetupImport(prev, parsed));
                addToast(`Đã nhập thiết lập thành công (${parsed.characters.length} nhân vật).`, 'success');
            } catch (err: any) {
                addToast(`Lỗi đọc file thiết lập: ${err.message || 'không xác định'}`, 'error');
            }
        };
        reader.onerror = () => addToast('Không đọc được file.', 'error');
        reader.readAsText(file, 'utf-8');
        e.target.value = '';
    };

    const handleRestoreSnapshot = (snapshotId: string) => {
        const snapshots = state.snapshots || [];
        const idx = snapshots.findIndex(s => s.id === snapshotId);
        if (idx === -1) return;
        const target = snapshots[idx];
        if (!confirm(`Khôi phục về thời điểm trước lượt viết này? Truyện sẽ quay lại còn ${target.chapterCountBefore} chương.`)) {
            return;
        }
        setState(prev => ({
            ...prev,
            chapters: target.chapters,
            characters: target.characters,
            seriesPremise: target.seriesPremise || prev.seriesPremise,
            continuitySummary: target.continuitySummary || target.premise,
            storyControl: target.storyControl || prev.storyControl,
            storyState: target.storyState || prev.storyState,
            memoryIndex: target.memoryIndex || prev.memoryIndex,
            snapshots: snapshots.slice(0, idx)
        }));
        setSetup({ premise: target.continuitySummary || target.premise });
        addToast(`Đã khôi phục về mốc ${target.chapterCountBefore} chương.`, 'success');
    };

    return {
        currentStep, setCurrentStep,
        mode, setMode,
        isAnalyzing, setIsAnalyzing,
        userPrompt, setUserPrompt,
        fileInputRef, chaptersEndRef,
        setupFileInputRef,
        isGenerating, setIsGenerating, handleStopGenerating,
        engineProgress,
        editingCharId, setEditingCharId,
        charForm, setCharForm,
        handleSaveChar, handleEditChar, handleDeleteChar,
        setup, setSetup,
        seedTitle, premise, worldNotes, charNotes, outline, genre,
        handleAnalyzeNew, handleEpubUpload, handleGenerateCreativeChapters,
        handleSanityCheckStoryEngine,
        handleExportSetup, handleDownloadChapters, handleImportSetup,
        handleRestoreSnapshot,
    };
};
