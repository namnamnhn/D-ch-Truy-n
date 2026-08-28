// Picks which Gemini/DeepSeek models to use for a given tier + task type
// (translate / auto_fix / smart_fix), respecting the user's enabled-models
// list. Split out of the old monolithic `translator.ts` — logic unchanged.
import { MODEL_CONFIGS, IS_LITE } from '../../../constants';
import { TranslationTier } from '../../../types';

// Bản Lite: thay mọi chức năng của 3.1 Pro bằng 3.7 Flash (yêu cầu người dùng)
const PRO_MODEL = IS_LITE ? 'gemini-3.7-flash' : 'gemini-3.1-pro-preview';

export const getEffectiveModelsForTier = (
    tier: TranslationTier,
    taskType: 'translate' | 'auto_fix' | 'smart_fix',
    enabledModels: string[] = MODEL_CONFIGS.map(m => m.id)
): string[] => {
    // Bản Lite chỉ còn Flash/Lite/DeepSeek — tier khác (Normal/Pro/Full đều dính model
    // Pro đã xoá) tự quy về Flash phòng hờ caller cũ còn truyền vào.
    if (IS_LITE && tier !== 'flash' && tier !== 'lite' && tier !== 'deepseek') {
        tier = 'flash';
    }
    // Utility to strictly filter enabled models to prevent calling disabled ones.
    const filterModels = (models: string[]) => models.filter(id => enabledModels.includes(id) || enabledModels.length === 0);
    
    const getFallback = (defaultModels: string[]) => {
        const matchingModels = filterModels(defaultModels);
        if (matchingModels.length > 0) return matchingModels;
        return defaultModels;
    };

    // RULE 1: Smart Fix Button always uses Pro Models (Explicit user request, except Lite tier)
    if (taskType === 'smart_fix') {
        if (tier === 'lite') {
            return getFallback(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
        }
        if (tier === 'deepseek') {
            const deepseekModels = enabledModels.filter(m => m.startsWith('deepseek:'));
            if (deepseekModels.length > 0) return deepseekModels;
            return ['deepseek:deepseek-v4-flash'];
        }
        return getFallback([PRO_MODEL]);
    }

    // RULE 2: Pro Tier
    // - Translate: 3.1 Pro
    // - Auto Fix: 3.7 Flash (thay cho 3.6 Flash cũ)
    if (tier === 'pro') {
        if (taskType === 'translate') {
            return getFallback([PRO_MODEL]);
        } else {
            return getFallback(['gemini-3.7-flash']);
        }
    }

    // RULE 3: Normal Tier
    // - Translate: 3.1 Pro > 3.7 Flash > 3.6 Flash
    // - Auto Fix: 3.5 Flash > 3.0 Flash > 3.5 Flash Lite > 3.1 Flash Lite
    if (tier === 'normal') {
        if (taskType === 'translate') {
            return getFallback([PRO_MODEL, 'gemini-3.7-flash', 'gemini-3.6-flash']);
        } else {
            return getFallback(['gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
        }
    }

    // RULE 4: Full Tier
    // - Translate: 3.1 Pro > 3.7 Flash > 3.6 Flash > 3.0 Flash
    // - Auto Fix: 3.5 Flash > 3.5 Flash Lite > 3.1 Flash Lite
    if (tier === 'full') {
        if (taskType === 'translate') {
            return getFallback([PRO_MODEL, 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview']);
        } else {
            return getFallback(['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
        }
    }

    // RULE 5: Flash Tier
    // - Translate: 3.7 Flash > 3.6 Flash > 3.0 Flash
    // - Auto Fix: 3.5 Flash > 3.5 Flash Lite > 3.1 Flash Lite
    if (tier === 'flash') {
        if (taskType === 'translate') {
            return getFallback(['gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview']);
        } else {
            return getFallback(['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
        }
    }

    // RULE 6: Lite Tier
    // - Translate: 3.5 Flash Lite > 3.1 Flash Lite
    // - Auto Fix: 3.5 Flash Lite > 3.1 Flash Lite
    if (tier === 'lite') {
        return getFallback(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    }
    
    // RULE 7: DeepSeek Tier
    if (tier === 'deepseek') {
        const deepseekModels = enabledModels.filter(m => m.startsWith('deepseek:'));
        if (deepseekModels.length > 0) return deepseekModels;
        return ['deepseek:deepseek-v4-flash'];
    }
    
    return ['gemini-3.7-flash'];
};
