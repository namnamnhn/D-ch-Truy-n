import { CreativeChapter } from '../../types';
import { buildPlannerContext, buildWriterContext } from './contextBuilder';
import { getAllStoryModelRoutes } from './modelRouting';
import { validateArcRanges, getArcForChapter, projectCharactersForChapter, projectExposureRules, projectWorldFactsForChapter, getActiveMysteryStages } from './storyAccess';
import {
  BatchPlan, ChapterMemory, SanityCheckResult, StoryBible, StoryControl, StoryModelTier, StoryState,
  STORY_CONTROL_SCHEMA_VERSION, STORY_STATE_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION
} from './types';

function collectStrings(value: unknown, result = new Set<string>()): Set<string> {
  if (typeof value === 'string' && value.trim().length >= 4) result.add(value.trim());
  else if (Array.isArray(value)) value.forEach(item => collectStrings(item, result));
  else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(item => collectStrings(item, result));
  return result;
}

function forbiddenReaderTokens(control: StoryControl, chapter: number): string[] {
  const values = collectStrings(control.authorOnlySecrets);
  for (const raw of control.mysteryThreads || []) {
    if (raw && typeof raw === 'object') collectStrings((raw as Record<string, unknown>).actualTruth, values);
  }
  for (const fact of control.worldFacts || []) {
    if (fact.visibility === 'author_only' || fact.scope === 'hidden_truth' || (fact.unlockChapter || fact.revealChapter || 1) > chapter) {
      collectStrings(fact.secretTruth, values);
      if (fact.visibility === 'author_only' || fact.scope === 'hidden_truth') collectStrings(fact.fact, values);
    }
  }
  for (const character of Object.values(control.characterRegistry || {})) {
    if (!projectCharactersForChapter(control, chapter).available.some(item => item.id === character.id)) {
      collectStrings(character.forbiddenSpoilers, values);
    }
  }
  for (const arc of control.arcs || []) if (arc.startChapter > chapter) collectStrings(arc.forbiddenSpoilers, values);
  return Array.from(values);
}

function containsSecret(serialized: string, tokens: string[]): boolean {
  return tokens.some(token => token && serialized.includes(token));
}

function exactCoverage(control: StoryControl): boolean {
  try {
    validateArcRanges(control);
    const sorted = [...control.arcs].sort((a, b) => a.startChapter - b.startChapter);
    return sorted[0]?.startChapter === 1 && sorted[sorted.length - 1]?.endChapter === control.totalChapters
      && sorted.every((arc, index) => index === 0 || sorted[index - 1].endChapter + 1 === arc.startChapter);
  } catch {
    return false;
  }
}

export function runStoryEngineSanityCheck(options: {
  bible: StoryBible;
  control: StoryControl;
  state?: StoryState;
  memories?: ChapterMemory[];
  chapter?: number;
  modelAvailability?: Partial<Record<StoryModelTier, boolean>>;
  strict?: boolean;
}): SanityCheckResult {
  const { bible, control, state, memories = [], modelAvailability = {}, strict = true } = options;
  const chapter = options.chapter || Math.max(1, (state?.currentChapter || 0) + 1);
  const errors: string[] = [];
  const warnings: string[] = [];
  const modelRoutingRoles = getAllStoryModelRoutes(modelAvailability);
  if (control.schemaVersion !== STORY_CONTROL_SCHEMA_VERSION) errors.push('SCHEMA_MISMATCH: invalid StoryControl schema.');
  if (!control.sourceHash) errors.push('SOURCE_HASH_MISSING: StoryControl is not attributable to an author source.');
  if (!control.authoritativeBlueprint && !bible.blueprintV3 && strict) errors.push('AUTHORITATIVE_BLUEPRINT_MISSING.');
  else if (!control.authoritativeBlueprint && bible.blueprintV3) warnings.push('Authoritative blueprint is loaded through the Bible projection.');
  const coverage = exactCoverage(control);
  if (!coverage) errors.push('ARC_COVERAGE_INVALID: arcs do not exactly cover the configured story.');
  let arcMissing = false;
  try { getArcForChapter(control, chapter); } catch { arcMissing = true; errors.push(`ARC_MISSING: no arc covers chapter ${chapter}.`); }
  if (state && (state.schemaVersion !== STORY_STATE_SCHEMA_VERSION || state.sourceHash !== control.sourceHash)) {
    errors.push('DERIVED_STATE_INCOMPATIBLE: StoryState schema/sourceHash does not match StoryControl.');
  }
  const compatibleMemories = memories.filter(memory =>
    memory.schemaVersion === MEMORY_SCHEMA_VERSION && memory.sourceHash === control.sourceHash);
  if (memories.length !== compatibleMemories.length) warnings.push('Incompatible memory entries will be invalidated.');
  if (strict) {
    for (const route of modelRoutingRoles) {
      if (route.requiredInStrictMode && route.status === 'unavailable') errors.push(`MODEL_UNAVAILABLE: ${route.role}.`);
    }
  }

  let plannerContextLeakCheck = false;
  let writerContextLeakCheck = false;
  let activeCharacters: ReturnType<typeof projectCharactersForChapter> = { available: [], lockedCount: 0 };
  let worldFacts: ReturnType<typeof projectWorldFactsForChapter> = { available: [], locked: [] };
  let exposure = projectExposureRules(control, chapter, false);
  let stages: ReturnType<typeof getActiveMysteryStages> = [];
  if (!arcMissing) {
    activeCharacters = projectCharactersForChapter(control, chapter);
    worldFacts = projectWorldFactsForChapter(control, chapter);
    exposure = projectExposureRules(control, chapter, false);
    stages = getActiveMysteryStages(control, chapter);
    const safeState = state || {
      currentChapter: 0, characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [],
      longTermSeeds: [], recentConsequences: [], currentArcId: getArcForChapter(control, chapter).id,
      currentArcProgress: 0, unlockedCharacterIds: [], worldFactStates: {}
    };
    const prior: CreativeChapter[] = [];
    const plan: BatchPlan = {
      arcId: getArcForChapter(control, chapter).id, startChapter: chapter, endChapter: chapter,
      requestedChapterNumbers: [chapter], batchDirectives: [], charactersGated: [], antiDriftMeasures: [], planValid: true,
      chapters: [{ chapterNumber: chapter, arcId: getArcForChapter(control, chapter).id, title: '', focus: '',
        povCharacter: activeCharacters.available[0]?.id || '', pacingTarget: 'rising_action', requiredEvents: [],
        introducedCharacters: [], activeCharacters: [], worldFactInteractions: [], cluesDiscovered: [], forbiddenSpoilers: [] }]
    };
    const tokens = forbiddenReaderTokens(control, chapter);
    const planner = buildPlannerContext(bible, control, safeState, compatibleMemories, chapter, 1, prior);
    const writer = buildWriterContext(bible, control, plan, safeState, compatibleMemories, chapter, 1, prior);
    plannerContextLeakCheck = !containsSecret(planner, tokens);
    writerContextLeakCheck = !containsSecret(writer, tokens);
    if (!plannerContextLeakCheck) errors.push('PLANNER_CONTEXT_SECRET_LEAK.');
    if (!writerContextLeakCheck) errors.push('WRITER_CONTEXT_SECRET_LEAK.');
  }

  return {
    schemaVersion: control.schemaVersion,
    sourceHash: control.sourceHash,
    chapter,
    settingsLoaded: Boolean(control.settings || bible.storyEngineSettingsV3),
    blueprintLoaded: Boolean(control.authoritativeBlueprint || bible.blueprintV3),
    arcCount: control.arcs.length,
    exactArcCoverage: coverage,
    characterRegistryCount: Object.keys(control.characterRegistry || {}).length,
    activeCharacterCount: activeCharacters.available.length,
    lockedCharacterCount: activeCharacters.lockedCount,
    worldFactCount: control.worldFacts.length,
    activeWorldFactCount: worldFacts.available.length,
    lockedWorldFactCount: worldFacts.locked.length,
    authorOnlyWorldFactCount: control.worldFacts.filter(fact => fact.visibility === 'author_only').length,
    activeExposureRuleIds: exposure.ruleIds,
    readerKnowledgeCeiling: exposure.readerKnowledgeCeilings,
    activeMysteryStageIds: stages.map(item => item.stage.id),
    storyStateLoaded: Boolean(state),
    memoryEntryCount: compatibleMemories.length,
    knowledgeEntryCount: state?.knowledgeLedger?.length || 0,
    modelRoutingRoles,
    writerContextLeakCheck,
    plannerContextLeakCheck,
    errors,
    warnings,
    pass: errors.length === 0
  };
}
