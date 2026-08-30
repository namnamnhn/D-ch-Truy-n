/** Single source of truth for models that this application is permitted to call. */
export type GeminiQualityClass = 'PRO' | 'FLASH' | 'LITE' | 'SPECIALIZED';
export interface GeminiModelCapability {
  id: string;
  label: string;
  quality: GeminiQualityClass;
  stability: 'preview' | 'stable';
  contextTokens: number;
  outputTokens: number;
  capabilities: readonly ('text' | 'image')[];
}

export const GEMINI_MODEL_REGISTRY: readonly GeminiModelCapability[] = [
  { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro Preview', quality: 'PRO', stability: 'preview', contextTokens: 1_000_000, outputTokens: 65_536, capabilities: ['text'] },
  { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', quality: 'FLASH', stability: 'stable', contextTokens: 1_000_000, outputTokens: 65_536, capabilities: ['text'] },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', quality: 'FLASH', stability: 'stable', contextTokens: 1_000_000, outputTokens: 65_536, capabilities: ['text'] },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', quality: 'FLASH', stability: 'stable', contextTokens: 1_000_000, outputTokens: 65_536, capabilities: ['text'] },
  { id: 'gemini-3-flash-preview', label: 'Gemini 3 Flash Preview', quality: 'FLASH', stability: 'preview', contextTokens: 1_000_000, outputTokens: 65_536, capabilities: ['text'] },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', quality: 'LITE', stability: 'stable', contextTokens: 1_000_000, outputTokens: 32_768, capabilities: ['text'] },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite', quality: 'LITE', stability: 'stable', contextTokens: 1_000_000, outputTokens: 32_768, capabilities: ['text'] },
];

/** Kept separate so text routing cannot accidentally pick an image model. */
export const GEMINI_SPECIALIZED_MODELS = ['gemini-3.1-flash-lite-image', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it'] as const;
export const APPROVED_GEMINI_MODEL_IDS = GEMINI_MODEL_REGISTRY.map(model => model.id) as readonly string[];
export const getGeminiModel = (id: string) => GEMINI_MODEL_REGISTRY.find(model => model.id === id);
/** Gemini 3.6/3.7 managed endpoints reject legacy sampling knobs. */
export const supportsGeminiSamplingConfig = (id: string) => !/^gemini-3\.[67]-/.test(id);
