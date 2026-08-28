import { StoryModelRole, StoryModelRoute, StoryModelTier } from './types';

export const FAST_STORY_MODELS = [
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3-flash-preview',
  'gemini-3.5-flash-lite'
] as const;

export const QUALITY_STORY_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.7-flash',
  'gemini-3.6-flash'
] as const;

export const STRICT_QUALITY_STORY_MODELS = [
  'gemini-3.1-pro-preview'
] as const;

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
  'STORY_VALIDATOR_SEMANTIC'
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

export function getStoryModelCandidates(role: StoryModelRole, lite = false): readonly string[] {
  const route = getStoryModelRoute(role);
  if (role === 'STORY_VALIDATOR_SEMANTIC') return STRICT_QUALITY_STORY_MODELS;
  if (route.tier === 'FAST' || (lite && route.allowFastFallback)) return FAST_STORY_MODELS;
  return QUALITY_STORY_MODELS;
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
