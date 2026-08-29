import { getAiClient, SAFETY_SETTINGS } from './gemini';
import { testDeepSeekConnection } from './deepseek';

export interface ApiHealthResult {
    name: string;
    ok: boolean;
    detail: string;
    latencyMs: number;
}

const splitKeys = (raw?: string): string[] =>
    (raw || '').split(/[,\n]/).map(k => k.trim()).filter(Boolean);

const maskKey = (key: string): string => key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-4)}` : '••••';

const safeFailureDetail = (error: any): string => {
    const message = String(error?.message || error || '').toLowerCase();
    if (error?.code === 'SERVER_CONFIGURATION_MISSING') return error.message;
    if (error?.code === 'RATE_LIMITED' || /quota|exhausted|429|rate.?limit/.test(message)) return 'Hết quota / rate-limit';
    if (error?.code === 'PROVIDER_UNAVAILABLE') return 'Provider/model tạm không khả dụng';
    if (/api key not valid|api_key_invalid/.test(message)) return 'API Key không hợp lệ';
    if (/failed to fetch|network|cannot reach/.test(message)) return 'Lỗi mạng hoặc gateway cùng origin';
    return error?.message || 'Lỗi không xác định';
};

export const runApiHealthCheck = async (cfg: {
    enabledModels: string[];
    deepseekKeys?: string;
    deepseekModel?: string;
}): Promise<ApiHealthResult[]> => {
    const results: ApiHealthResult[] = [];

    {
        const model = cfg.enabledModels[0] || 'gemini-3.5-flash';
        const t0 = Date.now();
        try {
            await getAiClient().models.generateContent({
                model,
                contents: 'Hi',
                config: { maxOutputTokens: 5, safetySettings: SAFETY_SETTINGS }
            });
            results.push({ name: `Gemini server-side (${model})`, ok: true, detail: 'Kết nối tốt', latencyMs: Date.now() - t0 });
        } catch (error: any) {
            results.push({ name: `Gemini server-side (${model})`, ok: false, detail: safeFailureDetail(error), latencyMs: Date.now() - t0 });
        }
    }

    {
        const keys = splitKeys(cfg.deepseekKeys);
        const model = (cfg.deepseekModel || 'deepseek-v4-flash').split(',')[0].trim() || 'deepseek-v4-flash';
        const candidates = keys.length ? keys : [''];
        for (let index = 0; index < candidates.length; index++) {
            const key = candidates[index];
            const t0 = Date.now();
            const label = key ? `DeepSeek BYOK #${index + 1} (${maskKey(key)})` : 'DeepSeek server-side';
            try {
                await testDeepSeekConnection(key, model);
                results.push({ name: label, ok: true, detail: `OK qua ${model}`, latencyMs: Date.now() - t0 });
            } catch (error: any) {
                results.push({ name: label, ok: false, detail: safeFailureDetail(error), latencyMs: Date.now() - t0 });
            }
        }
    }

    return results;
};
