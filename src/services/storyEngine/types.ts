import { Character } from '../../types';

export const STORY_CONTROL_SCHEMA_VERSION = 3;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export type PipelineStage = 'compiler' | 'planning' | 'writing' | 'validating' | 'repairing' | 'extracting' | 'completed' | 'failed';

export interface PipelineProgressInfo {
  stage: PipelineStage;
  message: string;
  progress: number; // 0 - 100
  currentChapter?: number;
  totalChapters?: number;
  retryCount?: number;
}

// ----------------------------------------------------
// 1. STORY BIBLE (Nguồn tài liệu gốc từ người dùng)
// ----------------------------------------------------
export interface StoryBible {
  seedTitle: string;
  genre: string;
  seriesPremise: string;
  continuitySummary: string;
  worldNotes: string;
  charNotes: string;
  outline: string;
  characters: Character[];
  totalPlannedChapters?: number;
  storyEngineSettingsV3?: JsonObject;
  blueprintV3?: AuthoritativeBlueprintV3;
}

// ----------------------------------------------------
// 2. STORY CONTROL V3 (Kim chỉ nam bất biến cho toàn bộ 600 chương)
// ----------------------------------------------------
export interface ArcDefinition {
  id: string;
  title: string;
  startChapter: number;
  endChapter: number;
  theme: string;
  coreConflict: string;
  climaxChapter: number;
  pacing: 'slow_burn' | 'accelerating' | 'high_stakes' | 'climax' | 'resolution';
  unlockedCharacterIds: string[];
  keyMilestones: string[];
  worldBuildingFocus: string;
  forbiddenSpoilers: string[];
  source?: JsonObject;
}

export interface CharacterUnlockCondition {
  type: 'arc' | 'chapter' | 'clue' | 'event';
  value: string | number;
}

export interface CharacterRegistryEntry {
  id: string;
  name: string;
  aliasSet: string[];
  role: string;
  gender?: string;
  age?: string;
  initialFaction?: string;
  appearance: string;
  personality: string;
  coreMotivation: string;
  forbiddenSpoilers: string[];
  unlockCondition: CharacterUnlockCondition;
  allowedArcs: string[];
  deathOrExitChapter?: number;
  aliases?: string[];
  relationships?: JsonValue;
  restrictions: string[];
  unlockChapter?: number;
  directAppearanceChapter?: number;
  povUnlockChapter?: number;
  majorFocusNotBeforeChapter?: number;
  source?: JsonObject;
}

export interface WorldFact {
  id: string;
  category: 'magic_system' | 'geography' | 'faction' | 'history' | 'secret_rule' | string;
  fact: string;
  scope: 'public' | 'restricted' | 'hidden_truth';
  visibility: 'always' | 'gated' | 'author_only';
  introducedAtChapter: number;
  unlockChapter?: number;
  revealChapter?: number;
  gateCondition?: string;
  secretTruth?: string;
  source?: JsonObject;
}

export interface NarrativeExposureRules {
  prohibitedTopicsUntilChapter: { topic: string; unlockChapter: number }[];
  foreshadowingDirectives: { hint: string; plantArcId: string; payoffArcId: string }[];
  mandatoryKnowledgeByChapter: { chapter: number; requiredFactIds: string[] }[];
}

export interface NarrativeExposureRule {
  id: string;
  threadId?: string;
  startChapter: number;
  endChapter: number;
  allowedEvidence: string[];
  forbiddenEvidence: string[];
  allowedInferences: string[];
  forbiddenInferences: string[];
  readerKnowledgeCeiling: string;
  relatedWorldFactIds: string[];
  source?: JsonObject;
}

export interface MysteryStage {
  id: string;
  startChapter: number;
  endChapter: number;
  allowedKnowledge: string[];
  allowedEvidence: string[];
  allowedInferences: string[];
  readerKnowledgeCeiling?: string;
  source?: JsonObject;
}

export interface MysteryThread {
  id: string;
  question: string;
  actualTruth: string;
  stages: MysteryStage[];
  source?: JsonObject;
}

export type OriginalityRules = JsonValue;
export type StoryEngineSettings = JsonObject;
export type AuthorOnlySecrets = JsonValue[];

export interface AuthoritativeBlueprintV3 {
  schemaVersion?: JsonPrimitive;
  totalChapters?: number;
  settings?: JsonObject;
  characterRegistry: CharacterRegistryEntry[];
  worldFacts: WorldFact[];
  arcs: ArcDefinition[];
  narrativeExposureRules: JsonObject[] | NarrativeExposureRules;
  mysteryThreads: JsonValue[];
  characterGates: CharacterGate[];
  spoilerGates: SpoilerGate[];
  originality?: OriginalityRules;
  authorOnlySecrets: AuthorOnlySecrets;
  source: JsonObject;
}

export interface CharacterGate {
  characterId: string;
  characterName: string;
  unlockAtArcId: string;
  unlockAtChapter: number;
  prerequisiteClues: string[];
  reason: string;
}

export interface SpoilerGate {
  id: string;
  description: string;
  forbiddenBeforeChapter: number;
  permittedArcs: string[];
  relatedCharacters: string[];
}

export interface ContinuityRules {
  enforcePhysicalInjuryDuration: boolean;
  enforceResourceTracking: boolean;
  enforceRelationshipMemory: boolean;
  enforceClueDiscoveryProgression: boolean;
}

export interface PacingRules {
  minWordsPerChapter: number;
  maxWordsPerChapter: number;
  climaxPacingMultiplier: number;
  cooldownChaptersAfterClimax: number;
}

export interface StoryControl {
  version: 'v3' | 'v2';
  schemaVersion: typeof STORY_CONTROL_SCHEMA_VERSION;
  sourceHash: string;
  totalChapters: number;
  arcs: ArcDefinition[];
  characterRegistry: Record<string, CharacterRegistryEntry>;
  worldFacts: WorldFact[];
  narrativeExposureRules: JsonObject[] | NarrativeExposureRules;
  characterGates: CharacterGate[];
  spoilerGates: SpoilerGate[];
  continuityRules: ContinuityRules;
  pacingRules: PacingRules;
  settings?: StoryEngineSettings;
  mysteryThreads: JsonValue[];
  originality?: OriginalityRules;
  authorOnlySecrets: AuthorOnlySecrets;
  authoritativeBlueprint?: AuthoritativeBlueprintV3;
}

// ----------------------------------------------------
// 3. STORY STATE (Trạng thái động qua từng chương)
// ----------------------------------------------------
export interface CharacterInjury {
  type: string;
  bodyPart: string;
  severity: 'mild' | 'moderate' | 'severe' | 'critical';
  receivedChapter: number;
  expectedRecoveryChapter: number;
  restrictions: string[];
}

export interface CharacterState {
  characterId: string;
  name: string;
  location: string;
  physicalCondition: string;
  injuries: CharacterInjury[];
  knownFacts: string[];
  goals: string[];
  activeFaction?: string;
}

export interface StoryRelationship {
  characterA: string;
  characterB: string;
  trust: number; // 0 - 100
  hostility: number; // 0 - 100
  stage: string;
  debt?: string;
  lastMajorChangeChapter: number;
}

export interface StoryClue {
  id: string;
  clue: string;
  discoveredChapter: number;
  discoveredBy: string;
  knownInterpretations: string[];
  actualTruthHidden: string;
  resolved: boolean;
}

export interface LongTermSeed {
  id: string;
  plantedChapter: number;
  meaningHidden: string;
  eligibleCallbackFromChapter: number;
  status: 'planted' | 'foreshadowed' | 'resolved';
}

export interface StoryState {
  currentChapter: number;
  characterStates: Record<string, CharacterState>;
  relationships: StoryRelationship[];
  resources: {
    money?: string;
    businesses?: string[];
    properties?: string[];
    equipment?: string[];
    [key: string]: any;
  };
  clues: StoryClue[];
  unresolvedThreads: string[];
  longTermSeeds: LongTermSeed[];
  recentConsequences: string[];
  currentArcId: string;
  currentArcProgress: number; // 0 - 100%
  unlockedCharacterIds: string[];
  worldFactStates: Record<string, 'hidden' | 'foreshadowed' | 'revealed'>;
  activeFactions?: string[];
}

// ----------------------------------------------------
// 4. BATCH PLAN (Kế hoạch vi mô cho 2-10 chương)
// ----------------------------------------------------
export interface ChapterPlan {
  chapterNumber: number;
  arcId?: string;
  title: string;
  focus: string;
  povCharacter: string;
  pacingTarget: 'slow_build' | 'rising_action' | 'climax' | 'cliffhanger' | 'cool_down';
  requiredEvents: string[];
  introducedCharacters: string[];
  activeCharacters: string[];
  worldFactInteractions: string[];
  cluesDiscovered: string[];
  forbiddenSpoilers: string[];
  primaryGoal?: string;
  secondaryGoal?: string;
  plannedCharacters?: string[];
  plannedWorldFacts?: string[];
  plannedEvidence?: string[];
  plannedInferences?: string[];
  mysteryAdvancement?: string;
  mysteryStageId?: string;
  conflict?: string;
  expectedOutcome?: string;
  continuityRequirements?: string[];
  hookType?: string;
  majorFocusCharacter?: string;
  arcBeatIds?: string[];
}

export interface BatchPlan {
  arcId: string;
  startChapter: number;
  endChapter: number;
  chapters: ChapterPlan[];
  batchDirectives: string[];
  charactersGated: string[];
  antiDriftMeasures: string[];
  planValid: boolean;
  planValidationErrors?: string[];
  requestedChapterNumbers?: number[];
}

export type CharacterAccessLevel = 'LOCKED' | 'MENTION_ONLY' | 'DIRECT_ALLOWED' | 'POV_ALLOWED' | 'MAJOR_FOCUS_ALLOWED';

export interface CharacterAccess {
  level: CharacterAccessLevel;
  canMention: boolean;
  canAppearDirectly: boolean;
  canUsePov: boolean;
  canTakeMajorFocus: boolean;
  unlockChapter: number;
  directAppearanceChapter: number;
  povUnlockChapter: number;
  majorFocusNotBeforeChapter: number;
}

export interface ExposureProjection {
  ruleIds: string[];
  allowedEvidence: string[];
  forbiddenEvidence: string[];
  allowedInferences: string[];
  forbiddenInferences: string[];
  readerKnowledgeCeilings: string[];
  relatedWorldFactIds: string[];
}

export interface StoryEngineSanityInfo {
  chapter: number;
  arcId: string;
  activeCharacterCount: number;
  lockedCharacterCount: number;
  activeWorldFacts: string[];
  lockedWorldFacts: string[];
  activeExposureRuleIds: string[];
  mysteryStageIds: string[];
}

// ----------------------------------------------------
// 5. VALIDATION & AUTO-REPAIR
// ----------------------------------------------------
export const STORY_VIOLATION_TYPES = [
  'PREMATURE_EVIDENCE',
  'PREMATURE_INFERENCE',
  'READER_KNOWLEDGE_OVEREXPOSURE',
  'WORLD_FACT_GATE_VIOLATION',
  'MYSTERY_STAGE_VIOLATION',
  'PREMATURE_MYSTERY_RESOLUTION',
  'REAL_WORLD_CONTAMINATION',
  'ANACHRONISM',
  'CHRONOLOGY_CONTRADICTION',
  'LOCATION_CANON_CONTRADICTION',
  'CHARACTER_SKILL_DRIFT',
  'COMBAT_POWER_VIOLATION',
  'OPPONENT_COMPETENCE_FAILURE',
  'KNOWLEDGE_LEAK',
  'PLAN_VIOLATION',
  'ORIGINALITY_VIOLATION',
  'CLICHE_OVERUSE',
  'OUTPUT_STRUCTURE',
  'STATE_DELTA_INVALID',
  'QA_UNAVAILABLE',
  // Backward-compatible deterministic classes retained from Story Engine V3 Tasks 1/2.
  'CHARACTER_GATE',
  'SPOILER_LEAK',
  'PACING_RUSH',
  'INJURY_AMNESIA',
  'RESOURCE_CONTRADICTION',
  'CHARACTER_OOC',
  'WORLD_FACT_CONTRADICTION',
  'WORD_COUNT_DEFICIT'
] as const;

export type StoryViolationType = typeof STORY_VIOLATION_TYPES[number];
export type ViolationType = StoryViolationType;
export type StoryViolationSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface StoryViolation {
  type: StoryViolationType;
  severity: StoryViolationSeverity;
  message: string;
  chapterNumber?: number;
  evidence?: string;
  relatedRuleId?: string;
  relatedCharacter?: string;
  relatedThreadId?: string;
  suggestedRepair?: string;
  // Legacy aliases remain readable in saved projects and existing UI integrations.
  chapter?: number;
  quoteOrDescription?: string;
  reason?: string;
  repairInstruction?: string;
}

export type Violation = StoryViolation;

export interface StoryValidationResult {
  pass: boolean;
  status: 'PASS' | 'FAIL' | 'QA_UNAVAILABLE';
  violations: StoryViolation[];
  warnings?: StoryViolation[];
  attempts?: number;
  repairAttempts?: number;
  modelRole?: 'semantic-validator';
  // Kept for persisted-project/UI backward compatibility.
  continuityScore: number;
  pacingScore: number;
  semanticChecks: {
    characterGating: boolean;
    worldFactContinuity: boolean;
    spoilerContainment: boolean;
    pacingIntegrity: boolean;
    characterTraitConsistency: boolean;
  };
}

export type ValidationResult = StoryValidationResult;

// ----------------------------------------------------
// 6. MEMORY & CONTINUITY INDEX
// ----------------------------------------------------
export interface ChapterMemory {
  chapterNumber: number;
  title: string;
  summary: string;
  charactersInvolved: string[];
  locations: string[];
  clues?: string[];
  relationshipChanges?: string[];
  injuries?: string[];
  resources?: string[];
  longTermSeeds?: string[];
}
