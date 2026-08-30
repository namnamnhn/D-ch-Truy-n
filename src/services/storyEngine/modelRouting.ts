import { StoryModelRole, StoryModelRoute, StoryModelTier } from './types';
import { APPROVED_GEMINI_MODEL_IDS } from '../../../shared/geminiModelRegistry';

export const FAST_STORY_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite'
] as const;

export const QUALITY_STORY_MODELS = [
  'gemini-3.1-pro-preview'
] as const;

export interface StoryModelPolicy {
  FAST: readonly string[];
  QUALITY: readonly string[];
}

export const DEFAULT_STORY_MODEL_POLICY: StoryModelPolicy = {
  FAST: FAST_STORY_MODELS,
  QUALITY: QUALITY_STORY_MODELS
};

function approvedCandidatesForTier(tier: StoryModelTier, policy: StoryModelPolicy): string[] {
  const requested = tier === 'QUALITY' ? policy.QUALITY : policy.FAST;
  const oppositePolicy = new Set(tier === 'QUALITY' ? policy.FAST : policy.QUALITY);
  const oppositeDefaults = new Set<string>(tier === 'QUALITY' ? FAST_STORY_MODELS : QUALITY_STORY_MODELS);
  return [...new Set(requested)].filter(candidate =>
    !oppositePolicy.has(candidate) && !oppositeDefaults.has(candidate));
}

const TIERS: Record<StoryModelRole, StoryModelTier> = {
  STORY_CONTROL_COMPILER: 'QUALITY',
  PLANNER: 'FAST',
  PLAN_VALIDATOR_SEMANTIC: 'QUALITY',
  WRITER: 'QUALITY',
  STATE_EXTRACTOR: 'FAST',
  MEMORY_COMPACTOR: 'FAST',
  STORY_VALIDATOR_SEMANTIC: 'QUALITY',
  AUTO_REPAIR: 'QUALITY'
};

const STRICT_REQUIRED = new Set<StoryModelRole>([
  'STORY_CONTROL_COMPILER', 'PLAN_VALIDATOR_SEMANTIC', 'STORY_VALIDATOR_SEMANTIC', 'WRITER', 'AUTO_REPAIR'
]);

const FAST_FALLBACK_ALLOWED = new Set<StoryModelRole>([
  'PLANNER',
  'STATE_EXTRACTOR',
  'MEMORY_COMPACTOR'
]);

export function getStoryModelRoute(
  role: StoryModelRole,
  availability: Partial<Record<StoryModelTier, boolean>> = {}
): StoryModelRoute {
  const tier = TIERS[role];
  return {
    role,
    tier,
    requiredInStrictMode: STRICT_REQUIRED.has(role),
    allowFastFallback: FAST_FALLBACK_ALLOWED.has(role),
    status: availability[tier] === undefined ? 'unknown' : availability[tier] ? 'available' : 'unavailable'
  };
}

export function getAllStoryModelRoutes(
  availability: Partial<Record<StoryModelTier, boolean>> = {}
): StoryModelRoute[] {
  return (Object.keys(TIERS) as StoryModelRole[]).map(role => getStoryModelRoute(role, availability));
}

export function getStoryModelCandidates(
  role: StoryModelRole,
  lite = false,
  policy: StoryModelPolicy = DEFAULT_STORY_MODEL_POLICY
): readonly string[] {
  const route = getStoryModelRoute(role);
  const tier = route.tier === 'FAST' || (lite && route.allowFastFallback) ? 'FAST' : 'QUALITY';
  return approvedCandidatesForTier(tier, policy).filter(model => APPROVED_GEMINI_MODEL_IDS.includes(model));
}

export function isStoryModelAllowedForRole(
  role: StoryModelRole,
  modelId: string,
  policy: StoryModelPolicy = DEFAULT_STORY_MODEL_POLICY
): boolean {
  return getStoryModelCandidates(role, false, policy).includes(modelId);
}

export async function runApprovedStoryModelCandidates<T>(
  role: StoryModelRole,
  operation: (modelId: string) => Promise<T>,
  policy: StoryModelPolicy = DEFAULT_STORY_MODEL_POLICY
): Promise<T> {
  const candidates = getStoryModelCandidates(role, false, policy);
  if (candidates.length === 0) throw new Error(`No ${getStoryModelRoute(role).tier} candidate is configured for ${role}.`);
  let finalError: unknown;
  for (const candidate of candidates) {
    if (!isStoryModelAllowedForRole(role, candidate, policy)) continue;
    try {
      return await operation(candidate);
    } catch (error) {
      finalError = error;
    }
  }
  throw finalError instanceof Error
    ? finalError
    : new Error(`All approved ${getStoryModelRoute(role).tier} candidates are unavailable for ${role}.`);
}

export function canRunStoryRole(
  role: StoryModelRole,
  availability: Partial<Record<StoryModelTier, boolean>>,
  strict = true
): boolean {
  const route = getStoryModelRoute(role, availability);
  if (route.status === 'available') return true;
  if (!strict) return route.allowFastFallback && availability.FAST === true;
  return !route.requiredInStrictMode && route.allowFastFallback && availability.FAST === true;
}
