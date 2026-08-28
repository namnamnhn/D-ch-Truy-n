// Nhóm hàm PHÂN TÍCH NGỮ CẢNH truyện: phân tích từng đoạn (analyzeContextBatch), gộp nhiều
// kết quả phân tích lại (mergeContexts - đệ quy chia đôi), điều phối lấy mẫu + phân tích toàn
// bộ truyện (analyzeStoryContext), và gộp ngữ cảnh thô khi hết quota AI (refineRawContext).
import { getAiClient, smartExecution, SAFETY_SETTINGS } from '../../api/gemini';
import { StoryInfo, FileItem } from '../../../types';
import { cleanRepetitiveContent, extractPotentialEntities, extractGlossaryBlocks, deduplicateDictionary } from '../../../utils/text';
import { getSmartSampledFiles, chunkTextByFileBoundary } from '../../../utils/fileHelpers';
import { IS_LITE } from '../../../constants';
import { GLOSSARY_ANALYSIS_PROMPT, MERGE_CONTEXT_PROMPT } from '../../../constants';
import { AnalysisEngine, runDeepSeekWithFallback } from './engineDispatch';
import { isContentFilterFinishReason } from '../../../utils/contentFilterError';

export const analyzeContextBatch = async (
    contentChunk: string, storyInfo: StoryInfo, existingDictionary: string, useSearch: boolean = false,
    forcedCandidates?: string[], additionalRules: string = "", enabledModels?: string[],
    engine: AnalysisEngine = 'gemini', deepseekKey?: string, deepseekModel?: string
): Promise<string> => {
    let candidates = forcedCandidates || ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'];
    candidates = candidates.filter(id => enabledModels?.includes(id) ?? true);
    if (candidates.length === 0) candidates = forcedCandidates || ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'];
    const langs = storyInfo.languages.join(' ').toLowerCase();
    let sourceInstruction = "";
    
    if (langs.includes('trung') || langs.includes('chinese') || langs.includes('raw') || 
        langs.includes('anh') || langs.includes('english') || 
        langs.includes('nhật') || langs.includes('japan') || 
        langs.includes('hàn') || langs.includes('korea')) {
        sourceInstruction = "NGUỒN: RAW (NGOẠI NGỮ). BẮT BUỘC GIỮ NGUYÊN MẶT CHỮ GỐC Ở VẾ TRÁI (KEY). TUYỆT ĐỐI KHÔNG DỊCH VẾ TRÁI.";
    } else {
        sourceInstruction = "NGUỒN: CONVERT/TIẾNG VIỆT. BẮT BUỘC GIỮ TỪ GỐC TRONG VĂN BẢN (DÙ SAI CHÍNH TẢ) Ở VẾ TRÁI.";
    }

    const potentialEntities = extractPotentialEntities(contentChunk);
    const hintSection = potentialEntities.length > 0 
        ? `\n\n[GỢI Ý TỪ HỆ THỐNG (LOCAL EXTRACTION)]\nHệ thống đã quét sơ bộ và tìm thấy các cụm từ đáng chú ý sau. Hãy kiểm tra xem chúng là gì (Tên người, Địa danh, Chiêu thức, Vật phẩm...), dịch chúng và tìm thêm các tên riêng khác mà hệ thống bỏ sót:\n${potentialEntities.join(', ')}` 
        : "";

    // FIX (fix55): trước đây existingDictionary được truyền vào hàm nhưng KHÔNG hề được đưa vào
    // prompt gửi AI (dead parameter) — nghĩa là khi 1 truyện bị chia làm nhiều phần để phân tích
    // (vd phần 1-1000 / 1001-2000), phần sau hoàn toàn không biết phần trước đã tìm ra nhân vật/
    // thuật ngữ/xưng hô gì, dẫn tới phân tích rời rạc, thiếu nhất quán khi gộp lại. Giờ đưa thẳng
    // từ điển/ngữ cảnh đã có (nếu có) vào prompt, kèm chỉ dẫn rõ: dùng để GIỮ NHẤT QUÁN tên gọi đã
    // chốt, không tự ý dịch khác đi; chỉ bổ sung mục MỚI hoặc diễn biến MỚI (vd xưng hô đổi giai
    // đoạn) cho các mục đã có.
    const dictionarySection = existingDictionary && existingDictionary.trim()
        ? `\n\n[NGỮ CẢNH & TỪ ĐIỂN ĐÃ CÓ TỪ CÁC PHẦN TRƯỚC CỦA TRUYỆN NÀY — BẮT BUỘC THAM CHIẾU]\nĐây là những gì đã được phân tích/chốt từ (các) phần trước (nếu truyện bị chia nhiều phần để phân tích). TUYỆT ĐỐI giữ nhất quán tên gọi/thuật ngữ đã có ở đây, KHÔNG tự ý đổi cách dịch khác đi. Chỉ bổ sung thêm nhân vật/thuật ngữ MỚI xuất hiện trong đoạn dưới đây, hoặc diễn biến MỚI cho mục đã có (vd xưng hô của 1 cặp nhân vật đổi sang giai đoạn mới):\n${existingDictionary}`
        : "";

    const metaHeader = `[METADATA]\n- Tên: ${storyInfo.title}\n- Thể loại: ${storyInfo.genres.join(', ')}\n- Ngôn ngữ truyện: ${storyInfo.languages.join(', ')}\n- CHẾ ĐỘ: ${sourceInstruction}${additionalRules ? `\n- QUY TẮC BỔ SUNG: ${additionalRules}` : ''}${dictionarySection}${hintSection}`;

    if (engine === 'deepseek') {
        const dsText = await runDeepSeekWithFallback(deepseekKey || "", deepseekModel || "", GLOSSARY_ANALYSIS_PROMPT, `${metaHeader}\n${contentChunk}`, false);
        return cleanRepetitiveContent(dsText || "");
    }

    const ai = getAiClient();
    return await smartExecution(candidates, async (modelId) => {
            const config: any = { systemInstruction: GLOSSARY_ANALYSIS_PROMPT, temperature: 0.2, safetySettings: SAFETY_SETTINGS, maxOutputTokens: 65536 };
            if (useSearch && (modelId.includes('gemini-3.1-pro') || modelId.includes('gemini-3-pro'))) config.tools = [{googleSearch: {}}];
            const response = await ai.models.generateContent({ model: modelId, contents: `${metaHeader}\n${contentChunk}`, config });
            
            if (isContentFilterFinishReason(response.candidates?.[0]?.finishReason)) {
                throw new Error(`Bị chặn bởi bộ lọc an toàn (Safety Filter). Mặc dù đã dùng lệnh lách luật, nhưng nội dung quá nhạy cảm nên API vẫn từ chối. Vui lòng kiểm tra lại nội dung gốc. Finish Reason: ${response.candidates[0].finishReason}`);
            }
            
            return cleanRepetitiveContent(response.text || "");
        }, "Phân Tích Ngữ Cảnh", undefined, candidates[0]
    );
};

export const mergeContexts = async (
    contexts: string[], storyInfo: StoryInfo, enabledModels?: string[], forcedCandidates?: string[], pronounOverride?: string,
    engine: AnalysisEngine = 'gemini', deepseekKey?: string, deepseekModel?: string
): Promise<string> => {
    if (contexts.length === 0) return "";
    if (contexts.length === 1) return cleanRepetitiveContent(contexts[0]);
    
    // Recursive merge for large sets to avoid token limits
    if (contexts.length > 5) {
        const half = Math.ceil(contexts.length / 2);
        const left = await mergeContexts(contexts.slice(0, half), storyInfo, enabledModels, forcedCandidates, pronounOverride, engine, deepseekKey, deepseekModel);
        const right = await mergeContexts(contexts.slice(half), storyInfo, enabledModels, forcedCandidates, pronounOverride, engine, deepseekKey, deepseekModel);
        return mergeContexts([left, right], storyInfo, enabledModels, forcedCandidates, pronounOverride, engine, deepseekKey, deepseekModel);
    }

    if (engine === 'deepseek') {
        try {
            const dsPrompt = `[DỮ LIỆU ĐẦU VÀO - GỒM ${contexts.length} PHẦN]\n${contexts.join("\n\n=== HẾT PHẦN ===\n\n")}${pronounOverride ? `\n\n${pronounOverride}` : ''}`;
            const dsText = await runDeepSeekWithFallback(deepseekKey || "", deepseekModel || "", MERGE_CONTEXT_PROMPT, dsPrompt, false);
            return cleanRepetitiveContent(dsText || contexts[0]);
        } catch (e) {
            // FINAL FALLBACK: RAW LOCAL MERGE (Tổng hợp thô) — DeepSeek không có tier Pro/Flash tách
            // biệt như Gemini để "hợp nhất thô" 2 lớp, nên lỗi thì rơi thẳng về local merge.
            console.warn("Merge API (DeepSeek) failed. Performing Local Raw Merge.", e);
            return contexts.join("\n\n# ==================================================\n# [HỆ THỐNG: CHẾ ĐỘ TỔNG HỢP THÔ (LOCAL MERGE)]\n# Do lỗi DeepSeek, các phần dữ liệu được nối trực tiếp bên dưới.\n# ==================================================\n\n");
        }
    }

    // Try 3.0 Pro first, then 2.5 Pro as backup
    // Try 3.1 Pro first
    const proModels = (forcedCandidates || ['gemini-3.1-pro-preview']).filter(id => id.includes('pro') && (enabledModels?.includes(id) ?? true));
    if (proModels.length === 0) proModels.push('gemini-3.1-pro-preview');
    
    try {
        return await smartExecution(proModels, async (modelId) => {
                const response = await getAiClient().models.generateContent({
                    model: modelId,
                    contents: `[DỮ LIỆU ĐẦU VÀO - GỒM ${contexts.length} PHẦN]\n${contexts.join("\n\n=== HẾT PHẦN ===\n\n")}${pronounOverride ? `\n\n${pronounOverride}` : ''}`,
                    config: { systemInstruction: MERGE_CONTEXT_PROMPT, temperature: 0.2, safetySettings: SAFETY_SETTINGS, maxOutputTokens: 65536 }
                });
                   
                if (isContentFilterFinishReason(response.candidates?.[0]?.finishReason)) {
                    throw new Error(`Bị chặn bởi bộ lọc an toàn (Safety Filter). Mặc dù đã dùng lệnh lách luật, nhưng nội dung quá nhạy cảm nên API vẫn từ chối. Vui lòng kiểm tra lại nội dung gốc. Finish Reason: ${response.candidates[0].finishReason}`);
                }
                   
                return cleanRepetitiveContent(response.text || contexts[0]);
            }, "Hợp Nhất Ngữ Cảnh (Tích Lũy)", undefined, proModels[0]
        );
    } catch (e: any) {
        // FALLBACK: Try Flash models for a "Rough Merge" before giving up
        try {
            console.warn("Merge API (Pro) failed. Trying Flash for Rough Merge.", e);
            const fallbackModels = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'].filter(id => enabledModels?.includes(id) ?? true);
            if (fallbackModels.length === 0) fallbackModels.push('gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview');
            
            return await smartExecution(fallbackModels, async (modelId) => {
                const response = await getAiClient().models.generateContent({
                    model: modelId,
                    contents: `[DỮ LIỆU ĐẦU VÀO - GỒM ${contexts.length} PHẦN]\n${contexts.join("\n\n=== HẾT PHẦN ===\n\n")}\n\nNHIỆM VỤ: TỔNG HỢP THÔ DỮ LIỆU TRÊN. GIỮ NGUYÊN CÁC MỤC QUAN TRỌNG.${pronounOverride ? `\n\n${pronounOverride}` : ''}`,
                    config: { systemInstruction: MERGE_CONTEXT_PROMPT, temperature: 0.2, safetySettings: SAFETY_SETTINGS, maxOutputTokens: 65536 }
                });
                   
                if (isContentFilterFinishReason(response.candidates?.[0]?.finishReason)) {
                    throw new Error(`Bị chặn bởi bộ lọc an toàn (Safety Filter). Mặc dù đã dùng lệnh lách luật, nhưng nội dung quá nhạy cảm nên API vẫn từ chối. Vui lòng kiểm tra lại nội dung gốc. Finish Reason: ${response.candidates[0].finishReason}`);
                }
                   
                return cleanRepetitiveContent(response.text || contexts[0]);
            }, "Hợp Nhất Thô", undefined, fallbackModels[0]);
        } catch (flashError) {
            // FINAL FALLBACK: RAW LOCAL MERGE (Tổng hợp thô)
            console.warn("Merge API (Flash) failed. Performing Local Raw Merge.", flashError);
            
            const rawMerge = contexts.join("\n\n# ==================================================\n# [HỆ THỐNG: CHẾ ĐỘ TỔNG HỢP THÔ (LOCAL MERGE)]\n# Do hết Quota, các phần dữ liệu được nối trực tiếp bên dưới.\n# ==================================================\n\n");
            return rawMerge;
        }
    }
};


export const analyzeStoryContext = async (files: FileItem[], storyInfo: StoryInfo, dictionary: string = "", useSearch: boolean = false, additionalRules: string = "", sampling: { start: number, middle: number, end: number } = { start: 100, middle: 100, end: 100 }, enabledModels?: string[]): Promise<string> => {
    let filesToAnalyze = getSmartSampledFiles(files, sampling);
    // FIX59 (Lite): ngân sách cố định tối đa 200.000 ký tự, lấy mẫu Đầu/Giữa/Cuối xen kẽ
    // đến khi đủ ngân sách — người dùng không được chọn/see phạm vi quét.
    if (IS_LITE) {
        const BUDGET = 200000;
        const seg = Math.ceil(filesToAnalyze.length / 3);
        const parts = [filesToAnalyze.slice(0, seg), filesToAnalyze.slice(seg, 2 * seg), filesToAnalyze.slice(2 * seg)];
        const kept: typeof filesToAnalyze = [];
        const idx = [0, 0, 0];
        let used = 0, turn = 0;
        while (kept.length < filesToAnalyze.length) {
            const p = turn++ % 3;
            if (idx[p] >= parts[p].length) continue;
            const f = parts[p][idx[p]++];
            if (used + f.content.length > BUDGET && kept.length > 0) continue;
            kept.push(f); used += f.content.length;
        }
        filesToAnalyze = kept;
    }

    // FIX (fix56): người dùng xác nhận muốn đồng bộ TOÀN BỘ ngưỡng cắt chunk về 600.000, kể cả
    // Smart Start (trước đó fix54/fix55 cố tình giữ 950.000 vì nghĩ ngoài phạm vi yêu cầu — nay
    // người dùng đã xác nhận muốn đổi luôn cho thống nhất).
    const CHUNK_SIZE = 600000;
    const cleanedFiles = filesToAnalyze.map(f => {
        let safeContent = f.content;
        safeContent = safeContent.replace(/([1-9]\d*)0000(?!\d)/g, '$1万');
        safeContent = safeContent.replace(/\.{6,}/g, '...');
        safeContent = safeContent.replace(/!{4,}/g, '!!!');
        safeContent = safeContent.replace(/\?{4,}/g, '???');
        return { text: safeContent };
    });
    const chunks = chunkTextByFileBoundary(cleanedFiles, CHUNK_SIZE);

    const results: string[] = [];
    const targetModels = ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'].filter(id => enabledModels?.includes(id) ?? true);
    if (targetModels.length === 0) targetModels.push('gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview');
    
    const CONCURRENCY = 2;
    let completedChunks = 0;
    let progressNote = "";
    // FIX (fix55): "ngữ cảnh tích lũy" — trước batch đầu tiên chỉ có từ điển sẵn có (nếu có),
    // sau MỖI batch, rút gọn các mục [Key] = Value từ toàn bộ kết quả đã phân tích tới thời điểm
    // đó rồi gộp vào rollingDictionary, dùng làm "NGỮ CẢNH ĐÃ CÓ TỪ CÁC PHẦN TRƯỚC" cho (các)
    // batch tiếp theo (xem dictionarySection trong analyzeContextBatch). Nhờ vậy phần 2 (vd
    // 1001-2000) sẽ "biết" các nhân vật/thuật ngữ đã chốt ở phần 1 (1-1000) thay vì phân tích mù
    // hoàn toàn độc lập rồi mới gộp ở bước cuối — đây chính là nguyên nhân khiến phân tích chia
    // nhiều phần trước đây bị rời rạc, thiếu nhất quán so với phân tích 1 lần trọn vẹn.
    let rollingDictionary = dictionary || "";

    try {
        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batch = chunks.slice(i, i + CONCURRENCY);
            const dictForThisBatch = rollingDictionary;
            const batchPromises = batch.map(async (chunk, idx) => {
                const batchNum = Math.floor(i / CONCURRENCY) + 1;
                let models: string[] = [];
                if (batchNum <= 3) {
                    models = idx % 2 === 0 
                             ? ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview']
                             : ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'];
                } else {
                    models = ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'];
                }
                
                try {
                    return await analyzeContextBatch(chunk, storyInfo, dictForThisBatch, useSearch, models, additionalRules, enabledModels);
                } catch (e: any) {
                    console.warn(`Primary models failed for chunk ${i + idx}, falling back to Flash for raw analysis.`, e);
                    try {
                        const flashRes = await analyzeContextBatch(chunk, storyInfo, dictForThisBatch, useSearch, ['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'], additionalRules + "\nLƯU Ý: ĐÂY LÀ BẢN PHÂN TÍCH THÔ DO HẾT QUOTA. CHỈ TRÍCH XUẤT NHANH CÁC DANH TỪ RIÊNG.", enabledModels);
                        progressNote = "\n\n[CẢNH BÁO: Quá trình phân tích bị gián đoạn do hết Quota/Lỗi mạng. Một số phần được lưu dưới dạng phân tích thô bằng Flash.]";
                        return flashRes + "\n[GHI CHÚ: BẢN PHÂN TÍCH THÔ BẰNG FLASH DO HẾT QUOTA]";
                    } catch (flashError) {
                        console.error(`Flash fallback also failed for chunk ${i + idx}:`, flashError);
                        progressNote = "\n\n[CẢNH BÁO: Quá trình phân tích bị gián đoạn do hết Quota/Lỗi mạng. Một số phần bị bỏ qua.]";
                        return "";
                    }
                }
            });
            
            const batchResults = await Promise.all(batchPromises);
            const validResults = batchResults.filter(r => r.length > 50);
            results.push(...validResults);
            completedChunks += validResults.length;

            if (validResults.length > 0) {
                rollingDictionary = deduplicateDictionary(`${rollingDictionary}\n${extractGlossaryBlocks(validResults.join('\n'))}`);
            }
            
            if (i + CONCURRENCY < chunks.length) await new Promise(r => setTimeout(r, 2000));
        }
    } catch (e: any) {
        console.warn("Analysis interrupted (Quota/Network):", e);
        const percent = Math.round((completedChunks / chunks.length) * 100);
        
        // Fallback: Use 2.5 Flash to save raw progress if possible, otherwise just note it.
        // The user said: "sử dụng 2.5 flash để lưu lại thông tin phân tích theo dạng thô"
        // We will append a note saying we are saving raw data.
        progressNote = `\n\n# === [HỆ THỐNG GHI CHÚ TIẾN ĐỘ] ===\n- Trạng thái: TẠM DỪNG (Interrupted)\n- Lý do: Hết Quota API hoặc Lỗi mạng.\n- Tiến độ: Đã phân tích ${completedChunks}/${chunks.length} phần dữ liệu (~${percent}%).\n- Dữ liệu thô đã được lưu lại. Khi có Quota, hãy chạy lại Phân tích.`;
    }

    if (results.length === 0) return "Chưa phân tích được dữ liệu nào do lỗi kết nối/quota ngay từ đầu.";
    
    // Attempt merge even if interrupted
    let finalMerge = "";
    try {
        finalMerge = await mergeContexts(results, storyInfo);
    } catch {
        // Should not happen as mergeContexts now has local fallback, but safe check
        finalMerge = results.join("\n\n=== [DỮ LIỆU THÔ CHƯA HỢP NHẤT] ===\n\n");
    }

    return finalMerge + progressNote;
};

export const refineRawContext = async (rawContext: string, storyInfo: StoryInfo, enabledModels?: string[]): Promise<string> => {
    const parts = rawContext.split("# ==================================================\n# [HỆ THỐNG: CHẾ ĐỘ TỔNG HỢP THÔ (LOCAL MERGE)]\n# Do hết Quota, các phần dữ liệu được nối trực tiếp bên dưới.\n# ==================================================\n\n");
    if (parts.length <= 1) return rawContext; // Not raw merged data
    
    return await mergeContexts(parts, storyInfo, enabledModels);
};
