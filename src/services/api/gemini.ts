
import { logger } from "../../utils/logger";
import { quotaManager } from '../../utils/quotaManager';
import { MODEL_CONFIGS } from '../../constants';
import { createGatewayGeminiClient } from './providerGatewayClient';

// Gemini is configured by the AI Studio server-side Secrets runtime. Keeping
// this compatibility guard avoids changing Full/Lite routing policy in WP-FIN-02.
// A missing server secret is surfaced explicitly by the same-origin gateway.
export const ensureGeminiKeyForLite = (): boolean => true;

export const getAiClient = createGatewayGeminiClient;

const SAFETY_SETTINGS = [
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
    { category: 'HARM_CATEGORY_CIVIC_INTEGRITY', threshold: 'BLOCK_NONE' },
];

export { SAFETY_SETTINGS };

export const testCurrentKey = async (): Promise<{ success: boolean; message: string }> => {
    const ai = getAiClient();
    try {
        await ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: "Hi",
            config: { safetySettings: SAFETY_SETTINGS }
        });
        return { success: true, message: "Gemini server-side đã cấu hình và đang hoạt động." };
    } catch (error: any) {
        const msg = (error.message || error.toString()).toLowerCase();
        if (msg.includes("resource exhausted") || msg.includes("quota")) {
            return { success: false, message: "Key này đã hết Quota (Resource Exhausted)." };
        }
        if (error.code === 'SERVER_CONFIGURATION_MISSING') {
            return { success: false, message: "Thiếu GEMINI_API_KEY phía server. Hãy cấu hình trong AI Studio Settings > Secrets." };
        }
        if (msg.includes("api key not valid") || msg.includes("api_key_invalid") || (error.status === 400 && msg.includes('key'))) {
            return { success: false, message: "GEMINI_API_KEY phía server không hợp lệ hoặc đã bị khóa." };
        }
        return { success: false, message: error.message };
    }
};

export const testModelConnection = async (modelId: string): Promise<{ success: boolean; message: string }> => {
    const ai = getAiClient();
    try {
        const response = await ai.models.generateContent({
            model: modelId,
            contents: "Hi",
            config: { safetySettings: SAFETY_SETTINGS }
        });
        return response ? { success: true, message: "Kết nối thành công! Model sẵn sàng." } : { success: false, message: "Không có phản hồi." };
    } catch (error: any) {
        const msg = (error.message || error.toString()).toLowerCase();
        if (msg.includes("resource exhausted") || msg.includes("quota")) {
            quotaManager.markAsDepleted(modelId);
            return { success: false, message: "Model đã hết Quota (Resource Exhausted)." };
        }
        return { success: false, message: error.message };
    }
};

/**
 * "Vệ tinh" = các model không thuộc hệ Gemini nội bộ, không dùng quotaManager của Gemini,
 * mà tự quản lý key/rate limit riêng (DeepSeek). Trong smartExecution: chọn tuần tự theo
 * danh sách, lỗi thì loại khỏi danh sách thử (blacklist) thay vì đánh dấu "hết quota" theo
 * kiểu Gemini.
 */
const isSatelliteModel = (id: string) => id.startsWith('deepseek:');

/**
 * SMART EXECUTION ENGINE v3.1 (Retry Strategy)
 * - 2 Consecutive Errors -> Depleted.
 * - 1 Error -> Wait 1 minute -> Retry.
 * - Success -> Reset error count.
 */
export const smartExecution = async <T>(
    candidateModels: string[],
    operation: (modelId: string) => Promise<T>,
    taskName: string = "Tác vụ",
    onLog?: (msg: string) => void,
    preferredModelId?: string,
    priorityOverrides?: Record<string, number>
): Promise<T> => {
    logger.log(`[smartExecution] task: ${taskName}, candidateModels:`, candidateModels);
    const validCandidates = candidateModels.filter(id => isSatelliteModel(id) || MODEL_CONFIGS.some(c => c.id === id));
    logger.log(`[smartExecution] task: ${taskName}, validCandidates:`, validCandidates);
    const temporaryBlacklist: string[] = []; // Models that completely failed in this execution
    
    if (validCandidates.length === 0) {
        throw new Error(`[${taskName}] Không có model nào khả dụng. Vui lòng kiểm tra lại cài đặt.`);
    }

    const MAX_ITERATIONS = 50;
    let iterations = 0;

    while (iterations++ < MAX_ITERATIONS) {
        // 1. Get Best Model
        let selectedId: string | null = null;
        const satelliteCandidates = validCandidates.filter(id => isSatelliteModel(id));
        
        if (satelliteCandidates.length > 0) {
            selectedId = satelliteCandidates.find(id => !temporaryBlacklist.includes(id)) || null;
        } else {
            selectedId = quotaManager.getBestModelForTask(validCandidates, temporaryBlacklist, preferredModelId, priorityOverrides);
            const imageFallbackId = 'gemini-3.1-flash-lite-image';
            if (!selectedId
                && validCandidates.includes(imageFallbackId)
                && !temporaryBlacklist.includes(imageFallbackId)
                && quotaManager.isModelEnabled(imageFallbackId)
                && !quotaManager.isModelDepleted(imageFallbackId)
                && quotaManager.getWaitTimeForModel(imageFallbackId) <= 0) {
                selectedId = imageFallbackId;
            }
        }

        if (!selectedId) {
            // All exhausted or temporary blacklisted
            const allDepletedOrBlacklisted = validCandidates.every(id => 
                isSatelliteModel(id) ? temporaryBlacklist.includes(id) :
                ( (id !== 'gemini-3.1-flash-lite-image' && quotaManager.isModelDepleted(id)) || (id !== 'gemini-3.1-flash-lite-image' && !quotaManager.isModelEnabled(id)) || temporaryBlacklist.includes(id))
            );

            logger.log(`[smartExecution] task: ${taskName}, allDepletedOrBlacklisted:`, allDepletedOrBlacklisted, validCandidates.map(id => ({
                id,
                isDepleted: quotaManager.isModelDepleted(id),
                isEnabled: quotaManager.isModelEnabled(id),
                inBlacklist: temporaryBlacklist.includes(id)
            })));

            if (allDepletedOrBlacklisted) {
                 if (temporaryBlacklist.length > 0 && temporaryBlacklist.length === validCandidates.length) {
                     // FIX: trước đây LUÔN throw message chứa "hết Quota" dù nguyên nhân thực sự có
                      // thể chỉ là vệ tinh (DeepSeek) gặp lỗi khác (mạng, sai key, bị chặn
                      // nội dung phía vệ tinh) — khiến người dùng hiểu lầm là hết Quota Gemini dù đã
                      // add đủ Key dự phòng. Tách riêng thông báo cho trường hợp toàn bộ candidate là
                      // vệ tinh để phản ánh đúng bản chất lỗi.
                     const allSatellite = validCandidates.every(id => isSatelliteModel(id));
                     if (allSatellite) {
                         throw new Error(`[${taskName}] Vệ tinh dự phòng (${temporaryBlacklist.join(', ')}) đều gặp lỗi — không phải do hết lượt gọi API Gemini chính. Xem log phía trên để biết lỗi cụ thể từng vệ tinh (có thể do giới hạn tốc độ riêng, key sai, hoặc bị chặn nội dung phía vệ tinh).`);
                     }
                     // FIX (bug "bị chặn bộ lọc âm thầm -> dừng hệ thống -> báo sai hết Quota"):
                     // gắn tag máy-đọc được phân biệt 2 tình huống có cùng message:
                     //  - [CAUSE:DEPLETED]       : ít nhất 1 model ĐÃ bị đánh dấu cạn quota thật
                     //  - [CAUSE:BLACKLIST_TEMP] : KHÔNG model nào cạn thật - toàn bộ chỉ nằm trong
                     //    temporaryBlacklist của LƯỢT gọi này (thường do lỗi lặp lại/kết quả rỗng
                     //    liên tục — rất hay do bộ lọc nội dung chặn ÂM THẦM). Tầng trên
                     //    (useTranslator) dựa tag này để quyết định DỪNG hệ thống hay chỉ tạm nghỉ
                     //    rồi tự thử lại. Giữ nguyên cụm từ cũ ở ĐẦU message để không vỡ các nơi
                     //    đang dò chuỗi (streamTranslate re-throw list...).
                     const anyRealDepleted = validCandidates.some(id => !isSatelliteModel(id) && quotaManager.isModelDepleted(id));
                     throw new Error(`[${taskName}] Tất cả model đã thử đều gặp lỗi hoặc hết Quota. Dừng tác vụ. ${temporaryBlacklist.join(', ')} ${anyRealDepleted ? '[CAUSE:DEPLETED]' : '[CAUSE:BLACKLIST_TEMP]'}`);
                 }
                 
                 // Đề xuất cải thiện tồn đọng ("phân tích sâu Quota thật vs backoff tạm"): message
                 // debug cũ chỉ liệt kê enabled/depleted/waitTime từng model mà KHÔNG kết luận rõ
                 // ngay đầu message bản chất tình huống là gì — người đọc phải tự suy ra. Tính thêm
                 // 1 dòng tóm tắt: phân biệt "đã CẠN QUOTA THẬT" (depleted=true) với "chỉ đang tạm
                 // nghỉ do giới hạn tốc độ" (waitTime hữu hạn, CHƯA depleted) — 2 tình huống khác hẳn
                 // bản chất (1 cần đợi lâu/đổi model, 1 tự hồi sau vài giây-phút). CHỈ đổi phần chữ
                 // hiển thị/log, KHÔNG đổi bất kỳ quyết định luồng nào ở trên (an toàn, không ảnh
                 // hưởng hành vi cứu hộ/blacklist hiện có).
                 const depletedCount = validCandidates.filter(id => id !== 'gemini-3.1-flash-lite-image' && quotaManager.isModelDepleted(id)).length;
                 const disabledCount = validCandidates.filter(id => id !== 'gemini-3.1-flash-lite-image' && !quotaManager.isModelEnabled(id)).length;
                 const backoffOnlyCount = validCandidates.filter(id => {
                     if (id === 'gemini-3.1-flash-lite-image') return false;
                     if (quotaManager.isModelDepleted(id) || !quotaManager.isModelEnabled(id)) return false;
                     const wt = quotaManager.getWaitTimeForModel(id);
                     return wt > 0 && wt !== Infinity;
                 }).length;
                 let natureSummary: string;
                 if (depletedCount >= validCandidates.length) {
                     natureSummary = 'Đã CẠN QUOTA THẬT SỰ (toàn bộ model đủ điều kiện đều depleted=true).';
                 } else if (depletedCount > 0) {
                     natureSummary = `Một phần đã cạn Quota thật (${depletedCount}/${validCandidates.length} model), phần còn lại bị tắt hoặc lỗi khác.`;
                 } else if (backoffOnlyCount > 0) {
                     natureSummary = `CHƯA cạn Quota thật - các model đủ điều kiện chỉ đang tạm nghỉ do giới hạn tốc độ (backoff), sẽ tự thử lại khi hết thời gian chờ.`;
                 } else if (disabledCount >= validCandidates.length) {
                     natureSummary = 'Không phải hết Quota - toàn bộ model đủ điều kiện đang bị TẮT trong Cài đặt.';
                 } else {
                     natureSummary = 'Nguyên nhân hỗn hợp - xem chi tiết từng model bên dưới.';
                 }

                 const diagnostics = validCandidates.map(id => 
                     `${id}: enabled=${quotaManager.isModelEnabled(id)}, depleted=${quotaManager.isModelDepleted(id)}, waitTime=${quotaManager.getWaitTimeForModel(id)}`
                 ).join('; ');
                 
                 throw new Error(`[${taskName}] Tất cả model khả dụng đã hết Quota hoặc bị tắt hoặc bị lỗi. ${natureSummary} Debug: ${diagnostics} ${depletedCount > 0 ? '[CAUSE:DEPLETED]' : '[CAUSE:BLACKLIST_TEMP]'}`);
            }

            // Waiting logic (Cooldown)
            const activeCandidates = validCandidates.filter(id => !isSatelliteModel(id) && !temporaryBlacklist.includes(id));
            const waitTimes = activeCandidates.map(id => quotaManager.getWaitTimeForModel(id));
            const minWaitTime = Math.min(...waitTimes);
            
            const actualWait = minWaitTime > 0 && minWaitTime !== Infinity ? minWaitTime : 2000;
            const waitSeconds = (actualWait / 1000).toFixed(1);

            if (onLog) onLog(`💤 Hệ thống đang điều phối tải (Chờ xen kẽ). Đợi ${waitSeconds}s...`);
            await new Promise(resolve => setTimeout(resolve, actualWait));
            continue; // Retry loop
        }

        // --- MODEL SELECTED ---
        if (!isSatelliteModel(selectedId)) {
            quotaManager.recordRequest(selectedId);
        }

        try {
            if (onLog) onLog(`🚀 [${taskName}] Đang chạy trên model: ${selectedId}...`);
            if (!isSatelliteModel(selectedId)) {
                await new Promise(r => setTimeout(r, 600)); // Nhỏ giọt chống 429
            }
            const result = await operation(selectedId);
            
            // SUCCESS: Reset consecutive errors
            if (!isSatelliteModel(selectedId)) {
                quotaManager.recordSuccess(selectedId);
            }
            return result;
        } catch (error: any) {
            let msg = (error.message || error.toString()).toLowerCase();
            if (error.statusText) msg += " " + error.statusText.toLowerCase();

            // FIX (dừng phiên bị nuốt thành "hết Quota ảo"): lỗi ABORTED do người dùng chủ động
            // dừng không khớp nhánh phân loại nào bên dưới — rơi vào nhánh retry chung, mỗi
            // candidate model bị backoff thử lại ~3-4 lần vô ích rồi kết thúc bằng thông báo
            // "Tất cả model đã thử đều gặp lỗi hoặc hết Quota [CAUSE:BLACKLIST_TEMP]" gây hiểu
            // lầm. Người dùng đã dừng thì ném thẳng ra ngoài, không đụng quotaManager.
            const isAborted = error?.code === 'ABORTED' || error?.name === 'AbortError'
                || error?.status === 499 || error?.message === 'ABORTED' || /\babort(?:ed)?\b/i.test(error?.message || '');
            if (isAborted) throw error;

            // The server scheduler has already evaluated every eligible
            // profile/model target and honored bounded Retry-After cooldowns.
            // Never let the legacy browser quota manager reinterpret a
            // normalized gateway result by counting repeated 429s globally.
            const gatewayCodes = new Set([
                'QUOTA_EXHAUSTED', 'RATE_LIMITED', 'PROFILE_UNAVAILABLE',
                'PROFILE_MISCONFIGURED', 'MODEL_UNAVAILABLE', 'TEMPORARILY_UNAVAILABLE', 'PROVIDER_UNAVAILABLE',
                'SERVER_CONFIGURATION_MISSING', 'DEPLOYMENT_ACCESS_NOT_CONFIGURED'
            ]);
            if (gatewayCodes.has(error?.code)) {
                if (onLog) onLog(`⚠️ [${taskName}] ${error.message}`);
                throw error;
            }

            const isQuotaError = msg.includes('429') || msg.includes('exceeded quota') || msg.includes('quota exceeded') || msg.includes('resource exhausted') || msg.includes('quota');
            const isInvalidKey = msg.includes('api key not valid') || msg.includes('api_key_invalid') || (error.status === 400 && msg.includes('key')) || msg.includes('401 unauthorized');
            const isSafetyError = !isQuotaError && (msg.includes('bộ lọc an toàn') || msg.includes('safety') || msg.includes('blocklist') || msg.includes('prohibited_content'));
            const isHallucinationError = msg.includes('lặp từ hoặc mất thẻ') || msg.includes('tỷ lệ >') || msg.includes('vượt giới hạn');
            
            if (isInvalidKey) {
                 throw new Error("API Key không hợp lệ hoặc đã bị khóa.", { cause: error });
            }

            // FIX (bug "cứu hộ DeepSeek không hoạt động, báo nhầm hết Quota"): trước đây
            // các nhánh isSafetyError/isQuotaError/500/403 bên dưới chạy TRƯỚC nhánh isSatelliteModel
            // (vốn nằm tít bên dưới, dòng ~260 cũ) — nghĩa là lỗi trả về từ vệ tinh DeepSeek
            // bị hệ phân loại lỗi CỦA GEMINI nuốt mất:
            //  - Nếu message lỗi của DeepSeek tình cờ chứa "safety"/"blocklist"... ->
            //    `throw error` NGAY LẬP TỨC (nhánh isSafetyError cũ) mà không hề thử candidate vệ
            //    tinh nào khác, và bên gọi không phân biệt được đây là lỗi Gemini hay vệ tinh.
            //  - Nếu message chứa "429"/"quota" (rất hay gặp vì DeepSeek cũng trả lỗi
            //    dạng "429 Too Many Requests" khi rate-limit hoặc khi bị chặn nội dung phía họ) ->
            //    lọt vào guồng quotaManager CỦA GEMINI (markAsDepleted/getConfigs tìm modelConfig
            //    theo id Gemini - không tồn tại với id "deepseek:..."), rồi sau
            //    khi đủ số lần lỗi liên tiếp sẽ throw thẳng "Tất cả model đã thử đều gặp lỗi hoặc
            //    hết Quota" - khiến người dùng tưởng lầm là HẾT QUOTA trong khi thực chất vệ tinh
            //    đang gặp lỗi khác (nghẽn mạng, sai key, hoặc chính vệ tinh cũng chặn nội dung).
            // Kết quả thực tế: tính năng "cứu hộ" coi như KHÔNG chạy — lỗi bị dán nhãn sai và toàn
            // bộ tác vụ dừng lại với thông báo gây hiểu lầm.
            // SỬA: xử lý lỗi vệ tinh NGAY TẠI ĐÂY, trước mọi nhánh phân loại quota/safety phía dưới
            // (vốn chỉ thiết kế cho Gemini) — luôn chỉ log + đưa vào temporaryBlacklist + thử
            // candidate vệ tinh kế tiếp (nếu có), không đụng gì tới quotaManager của Gemini.
            if (isSatelliteModel(selectedId)) {
                const reason = isSafetyError ? 'nghi vấn bộ lọc nội dung phía vệ tinh' : isQuotaError ? 'giới hạn tốc độ/quota riêng của vệ tinh' : 'lỗi khác';
                const shortMsg = (error.message || String(error)).substring(0, 200);
                if (onLog) onLog(`⛔ Vệ tinh ${selectedId} gặp lỗi (${reason}): ${shortMsg}. Loại khỏi danh sách thử lần này...`);
                temporaryBlacklist.push(selectedId);
                continue;
            }
            
            if (isSafetyError) {
                if (onLog) onLog(`⚠️ Model ${selectedId} trả về lỗi (có thể do Safety Filter / rỗng). Trả về lỗi ngay để chia nhỏ batch và thử lại...`);
                throw error; // Throw immediately so useTranslator can split the batch
            }
            
            if (isHallucinationError) {
                if (onLog) onLog(`⚠️ Model ${selectedId} bị ảo giác (lặp từ). Bỏ qua model này cho mẻ hiện tại.`);
                temporaryBlacklist.push(selectedId);
                continue; // Skip this model and try another one
            }
            
            if (isQuotaError) {
                // We no longer strictly isolate 'per day' strings to immediately deplete the model
                // because Google often returns 'GenerateRequestsPerDayPerProjectPerModel' even for rate limits.
                // It will go through the normal 429 retry logic below.
                
                quotaManager.recordQuotaError(selectedId);
                const usage = quotaManager.getModelUsage(selectedId);
                const quotaErrorCount = usage.consecutiveQuotaErrors || 0;
                
                // Check hard request limit from config
                const modelConfig = quotaManager.getConfigs().find((m: any) => m.id === selectedId);
                const isHardLimitReached = modelConfig && usage.requestsToday >= modelConfig.rpdLimit;

                if (isHardLimitReached) {
                    if (onLog) onLog(`⛔ CƯỠNG CHẾ HẾT QUOTA: Model ${selectedId} đã chạm ngưỡng giới hạn request cứng (${usage.requestsToday}/${modelConfig.rpdLimit}).`);
                    quotaManager.markAsDepleted(selectedId);
                    temporaryBlacklist.push(selectedId);
                    continue;
                }

                // FIX51 (giữ nguyên tinh thần): KHÔNG markAsDepleted() (isDepleted=true vĩnh viễn
                // tới hết ngày) chỉ vì vài lần 429 dồn dập — con số đó rất dễ chỉ là burst
                // rate-limit (RPM) tạm thời, không phải thật sự cạn Quota ngày (RPD).
                //
                // FIX53 (bản này): fix51/52 sau khi bỏ markAsDepleted() ở nhánh này lại vô tình
                // tạo ra vòng lặp VÔ HẠN — mỗi lần cooldown 10 phút hết hạn, hệ thống tự thử lại,
                // vẫn dính 429 (vì Quota ngày thật sự đã cạn), quotaErrorCount lại tăng thêm 1
                // (3 -> 4 -> 5 -> 6...) rồi lại cooldown tiếp 10 phút — cứ thế lặp mãi, KHÔNG BAO
                // GIỜ chính thức báo "hết Quota" để dừng hẳn (bằng chứng: nhật ký lỗi người dùng
                // cung cấp cho thấy chuỗi "liên tục 3 lần" -> "4 lần" -> "5 lần" -> "6 lần" cách
                // nhau đúng ~10 phút, kéo dài nhiều giờ không dứt).
                //
                // SỬA: thêm bậc thang rõ ràng, có điểm dừng thật:
                //  - Lần 1/2/3 (quotaErrorCount 1-3): thử nhanh ngay, đợi 5s / 10s / 15s.
                //  - Lần 4: coi là "khá chắc bị rate-limit nặng" -> tạm nghỉ 1 phút (giảm từ 10
                //    phút, sau đó giảm tiếp từ 5 phút xuống 1 phút theo yêu cầu người dùng) rồi để
                //    hệ thống tự thử lại — CHƯA kết luận hết Quota thật.
                //  - Lần 5 trở đi (tức là SAU KHI đã nghỉ 1 phút rồi thử lại mà VẪN dính 429):
                //    đây mới là bằng chứng đủ mạnh -> chính thức markAsDepleted() (isDepleted=true
                //    tới hết ngày) và dừng hẳn model này, không lặp cooldown vô hạn nữa.
                if (quotaErrorCount >= 5) {
                     if (onLog) onLog(`⛔ Model ${selectedId} vẫn báo lỗi Quota (429) sau khi đã tạm nghỉ 1 phút rồi thử lại — xác nhận đã hết Quota thực sự, dừng model này.`);
                     quotaManager.markAsDepleted(selectedId);
                     temporaryBlacklist.push(selectedId);
                     continue;
                } else if (quotaErrorCount === 4) {
                     if (onLog) onLog(`⏸️ Model ${selectedId} báo lỗi Quota (429) liên tục ${quotaErrorCount} lần — tạm nghỉ 1 phút rồi tự thử lại (nếu vẫn lỗi sau đó mới chính thức xác nhận hết Quota), các model/tệp khác vẫn tiếp tục...`);
                     quotaManager.recordRateLimit(selectedId, 60000);
                     temporaryBlacklist.push(selectedId);
                     continue;
                } else {
                     let waitTimeSeconds = 5;
                     if (quotaErrorCount === 2) waitTimeSeconds = 10;
                     else if (quotaErrorCount === 3) waitTimeSeconds = 15;

                     const waitTime = waitTimeSeconds * 1000;
                     if (onLog) onLog(`⚠️ Model ${selectedId} dính Quota/Rate limit (429). Lần ${quotaErrorCount}, thử lại sau ${waitTimeSeconds}s...`);
                     quotaManager.recordRateLimit(selectedId, waitTime);
                     await new Promise(r => setTimeout(r, waitTime));
                     continue;
                }
            }

            if (error.status === 400 || msg.includes('400')) {
                if (onLog) onLog(`⚠️ CẢNH BÁO LỖI trên model ${selectedId}: ${msg.substring(0, 150)}.`);
            }

            if (msg.includes('500') || error.status >= 500 || msg.includes('503') || msg.includes('overloaded')) {
                quotaManager.recordError(selectedId);
                const usage = quotaManager.getModelUsage(selectedId);
                const errorCount = usage.consecutiveErrors || 0;
                
                if (errorCount >= 3) {
                     if (onLog) onLog(`🚨 Lỗi máy chủ Google (${selectedId}) 3 lần liên tiếp. Bỏ qua model này cho mẻ hiện tại.`);
                     temporaryBlacklist.push(selectedId);
                     // DO NOT markAsDepleted() vì đây chỉ là lỗi server tạm thời
                     continue;
                } else {
                     if (onLog) onLog(`🚨 Lỗi máy chủ Google trên ${selectedId}. Đợi 5s rồi thử lại...`);
                     quotaManager.recordRateLimit(selectedId, 5000);
                     await new Promise(r => setTimeout(r, 5000));
                     continue;
                }
            }

            if (error.status === 403 || msg.includes('403') || msg.includes('permission_denied')) {
                if (onLog) onLog(`⛔ CẢNH BÁO 403 FORBIDDEN trên model ${selectedId}: API Key hiện tại không có quyền truy cập.`);
                quotaManager.markAsDepleted(selectedId);
                temporaryBlacklist.push(selectedId);
                continue;
            }

            // For satellite models (DeepSeek): đã xử lý ở TRÊN CÙNG catch block (xem
            // comment "FIX bug cứu hộ DeepSeek"), nên không bao giờ chạy tới đây nữa.
            // Giữ lại nhánh này (không xoá hẳn) chỉ để phòng hờ nếu sau này có thêm loại satellite
            // mới mà quên thêm vào `isSatelliteModel()`.
            if (isSatelliteModel(selectedId)) {
                if (onLog) onLog(`⛔ CẢNH BÁO: Model ${selectedId} lỗi (${msg.substring(0, 150)}). Loại bỏ khỏi danh sách thử.`);
                temporaryBlacklist.push(selectedId);
                continue;
            }

            // Normal Error Handle (Network, Parsed, Unknown)
            quotaManager.recordError(selectedId);
            
            const usage = quotaManager.getModelUsage(selectedId);
            const errorCount = usage.consecutiveErrors || 0;
            const maxRetries = 3;
            const hardErrorLimit = selectedId.includes("pro") ? 25 : 105;
            if (errorCount >= hardErrorLimit) {
                if (onLog) onLog(`⛔ CƯỠNG CHẾ HẾT QUOTA: Model ${selectedId} lỗi liên tiếp ${errorCount} lần. Đánh dấu hết Quota!`);
                quotaManager.markAsDepleted(selectedId);
                temporaryBlacklist.push(selectedId);
                continue;
            }

            if (errorCount <= maxRetries) {
                // STRIKE: Exponential Backoff (2s, 4s, 8s)
                const backoffSeconds = Math.pow(2, errorCount); 
                const waitTime = backoffSeconds * 1000;
                
                if (onLog) onLog(`⚠️ Lỗi lần ${errorCount}/${maxRetries} trên ${selectedId}. Đợi ${backoffSeconds}s trước khi thử lại... (${msg.substring(0, 50)}...)`);
                
                quotaManager.recordRateLimit(selectedId, waitTime);
                await new Promise(r => setTimeout(r, waitTime));
            } else {
                // MAX STRIKES: Lỗi nặng, bỏ qua cho mẻ dịch này, NHƯNG không đánh dấu hết Quota
                if (onLog) onLog(`⛔ Model ${selectedId} lỗi ${maxRetries} lần liên tiếp không xác định rõ. Loại khỏi lần thử hiện tại.`);
                temporaryBlacklist.push(selectedId);
            }
            
            // Short pause
            await new Promise(r => setTimeout(r, 500));
        }
    }

    throw new Error(`[${taskName}] Vượt quá số lần thử tối đa (${MAX_ITERATIONS}). Dừng tác vụ để tránh lặp vô hạn.`);
};
