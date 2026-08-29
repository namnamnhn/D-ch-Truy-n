import { CreativeChapter } from '../../types';
import {
  ArcDefinition,
  BatchPlan,
  ChapterMemory,
  ChapterPlan,
  InBatchContinuityLock,
  StoryBible,
  StoryControl,
  StoryState
} from './types';
import { createEmptyInBatchContinuityLock, extendInBatchContinuityLock, formatInBatchContinuityLock } from './continuityLock';
import { createWriterOutputLanguageContract, formatOutputLanguageContract } from './languageContract';
import { calculateArcProgress } from './arcController';
import { formatMemoriesForContext, retrieveRelevantMemories, sanitizeMemoriesForReader } from './memoryManager';
import {
  getActiveMysteryStages,
  getArcForChapter,
  projectCharactersForChapter,
  projectExposureRules,
  projectWorldFactsForChapter
} from './storyAccess';

type SafeArc = Omit<ArcDefinition, 'source' | 'forbiddenSpoilers'>;

export interface ReaderSafeMysteryStage {
  threadId: string;
  stageId: string;
  allowedKnowledge: string[];
  allowedEvidence: string[];
  allowedInferences: string[];
  readerKnowledgeCeiling?: string;
}

export interface PlannerView {
  kind: 'planner';
  chapter: number;
  arc: SafeArc;
  arcProgress: number;
  readerSafePremise?: string;
  exposure: ReturnType<typeof projectExposureRules>;
  worldFacts: ReturnType<typeof projectWorldFactsForChapter>['available'];
  characters: ReturnType<typeof projectCharactersForChapter>['available'];
  mysteryStages: ReaderSafeMysteryStage[];
  storyState: ReturnType<typeof projectReaderSafeState>;
  relevantMemories: ChapterMemory[];
  recentContext: string;
}

export interface WriterView extends Omit<PlannerView, 'kind'> {
  kind: 'writer';
  approvedPlan: Partial<ChapterPlan>;
  inBatchContinuityLock: InBatchContinuityLock;
}

export interface ValidatorView {
  kind: 'validator';
  chapter: number;
  currentArc: ArcDefinition;
  storyControl: StoryControl;
  approvedPlan: ChapterPlan;
  batchPlan: BatchPlan;
  storyState: StoryState;
  generatedChapter?: CreativeChapter | string;
  adjacentGeneratedChapters: CreativeChapter[];
  relevantPriorChapters: CreativeChapter[];
  relevantMemories?: ChapterMemory[];
}

function projectArc(arc: ArcDefinition): SafeArc {
  const { source: _source, forbiddenSpoilers: _forbiddenSpoilers, ...safe } = arc;
  return safe;
}

function getReaderSafePremise(control: StoryControl): string | undefined {
  const value = control.settings?.readerSafePremise;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function projectReaderSafeState(control: StoryControl, state: StoryState, chapter: number) {
  const availableCharacters = new Set(projectCharactersForChapter(control, chapter).available
    .filter(character => character.access !== 'MENTION_ONLY')
    .map(character => character.id));
  const availableFacts = new Set(projectWorldFactsForChapter(control, chapter).available.map(fact => fact.id));
  return {
    currentChapter: state.currentChapter,
    characterStates: Object.fromEntries(Object.entries(state.characterStates || {}).filter(([, value]) =>
      availableCharacters.has(value.characterId))),
    relationships: (state.relationships || []).filter(relationship =>
      availableCharacters.has(relationship.characterA) && availableCharacters.has(relationship.characterB)),
    resources: state.resources,
    clues: (state.clues || []).map(({ actualTruthHidden: _actualTruthHidden, ...readerSafeClue }) => readerSafeClue),
    unresolvedThreads: state.unresolvedThreads,
    recentConsequences: state.recentConsequences,
    consequences: (state.consequences || []).filter(item => item.status === 'active'),
    knowledgeLedger: (state.knowledgeLedger || []).filter(entry => !entry.characterId || availableCharacters.has(entry.characterId)),
    timeline: (state.timeline || []).slice(-30),
    currentArcId: getArcForChapter(control, chapter).id,
    worldFactStates: Object.fromEntries(Object.entries(state.worldFactStates || {}).filter(([id]) => availableFacts.has(id)))
  };
}

function projectMysteryStages(control: StoryControl, chapter: number): ReaderSafeMysteryStage[] {
  return getActiveMysteryStages(control, chapter).map(({ threadId, stage }) => ({
    threadId,
    stageId: stage.id,
    allowedKnowledge: stage.allowedKnowledge,
    allowedEvidence: stage.allowedEvidence,
    allowedInferences: stage.allowedInferences,
    readerKnowledgeCeiling: stage.readerKnowledgeCeiling
  }));
}

function recentContext(recentChapters: CreativeChapter[], chapter: number): string {
  const last = recentChapters[recentChapters.length - 1];
  return last
    ? `${last.title}\n${last.content.slice(-1000)}`
    : chapter === 1 ? 'Điểm bắt đầu tác phẩm.' : 'Không có văn bản chương trước trong context.';
}

function projectApprovedChapterPlan(plan: BatchPlan, chapter: number): Partial<ChapterPlan> {
  const chapterPlan = plan.chapters.find(candidate => candidate.chapterNumber === chapter);
  if (!chapterPlan) throw new Error(`Writer View thiếu ChapterPlan đã duyệt cho Chương ${chapter}.`);
  const {
    forbiddenSpoilers: _forbiddenSpoilers,
    ...safePlan
  } = chapterPlan;
  return safePlan;
}

export function createPlannerView(
  _bible: StoryBible,
  control: StoryControl,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  chapter: number,
  recentChapters: CreativeChapter[]
): PlannerView {
  const arc = getArcForChapter(control, chapter);
  const characters = projectCharactersForChapter(control, chapter).available;
  const activeCharacterIds = characters.map(character => character.id);
  const activeNames = characters.map(character => character.name);
  const activeStates = Object.values(state.characterStates || {}).filter(character =>
    activeCharacterIds.includes(character.characterId) || activeNames.includes(character.name));
  const relevantMemories = sanitizeMemoriesForReader(retrieveRelevantMemories(memoryIndex, {
    currentChapter: chapter,
    currentArcId: arc.id,
    characterIds: activeCharacterIds,
    characterNames: activeNames,
    locations: activeStates.flatMap(character => [character.location, character.priorLocation || '']).filter(Boolean),
    threadIds: state.unresolvedThreads,
    factIds: (state.knowledgeLedger || []).map(entry => entry.factId),
    seedIds: (state.longTermSeeds || []).filter(seed => seed.status !== 'resolved').map(seed => seed.id),
    injuryIds: activeStates.flatMap(character => character.injuries || []).filter(injury => injury.status !== 'recovered')
      .map(injury => injury.id || injury.type),
    relationshipIds: (state.relationships || []).filter(relationship => activeNames.includes(relationship.characterA)
      || activeNames.includes(relationship.characterB)).map(relationship =>
        [relationship.characterA, relationship.characterB].sort().join('###')),
    text: `${arc.theme} ${arc.coreConflict}`
  }, 4), control);
  return {
    kind: 'planner',
    chapter,
    arc: projectArc(arc),
    arcProgress: calculateArcProgress(arc, chapter).arcProgress,
    readerSafePremise: getReaderSafePremise(control),
    exposure: projectExposureRules(control, chapter, false),
    worldFacts: projectWorldFactsForChapter(control, chapter).available,
    characters,
    mysteryStages: projectMysteryStages(control, chapter),
    storyState: projectReaderSafeState(control, state, chapter),
    relevantMemories,
    recentContext: recentContext(recentChapters, chapter)
  };
}

export function createWriterView(
  bible: StoryBible,
  control: StoryControl,
  plan: BatchPlan,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  chapter: number,
  recentChapters: CreativeChapter[],
  continuityLock: InBatchContinuityLock = createEmptyInBatchContinuityLock()
): WriterView {
  const planner = createPlannerView(bible, control, state, memoryIndex, chapter, recentChapters);
  const approvedPlan = projectApprovedChapterPlan(plan, chapter);
  const povReference = typeof approvedPlan.povCharacter === 'string' ? approvedPlan.povCharacter.toLocaleLowerCase('vi-VN') : '';
  const povCharacter = planner.characters.find(character =>
    character.id.toLocaleLowerCase('vi-VN') === povReference || character.name.toLocaleLowerCase('vi-VN') === povReference);
  const povSafeStates = Object.fromEntries(Object.entries(planner.storyState.characterStates).map(([key, characterState]) => {
    if (povCharacter && characterState.characterId === povCharacter.id) return [key, characterState];
    return [key, { ...characterState, knownFacts: [], goals: [] }];
  }));
  return {
    ...planner,
    kind: 'writer',
    storyState: { ...planner.storyState, characterStates: povSafeStates },
    approvedPlan,
    inBatchContinuityLock: continuityLock
  };
}

export function createValidatorView(
  control: StoryControl,
  plan: BatchPlan,
  state: StoryState,
  chapter: number,
  output?: CreativeChapter | string,
  adjacentGeneratedChapters: CreativeChapter[] = [],
  relevantPriorChapters: CreativeChapter[] = [],
  relevantMemories: ChapterMemory[] = []
): ValidatorView {
  const approvedPlan = plan.chapters.find(candidate => candidate.chapterNumber === chapter);
  if (!approvedPlan) throw new Error(`Validator View thiếu ChapterPlan đã duyệt cho Chương ${chapter}.`);
  return {
    kind: 'validator',
    chapter,
    currentArc: getArcForChapter(control, chapter),
    storyControl: control,
    approvedPlan,
    batchPlan: plan,
    storyState: state,
    generatedChapter: output,
    adjacentGeneratedChapters,
    relevantPriorChapters,
    relevantMemories
  };
}

export function buildPlannerContext(
  bible: StoryBible,
  control: StoryControl,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  nextChapter: number,
  batchSize: number,
  recentChapters: CreativeChapter[]
): string {
  const views = Array.from({ length: batchSize }, (_, index) =>
    createPlannerView(bible, control, state, memoryIndex, nextChapter + index, recentChapters));
  return `=== LONG-FORM STORY ENGINE V3: PLANNER CONTEXT ===\n${JSON.stringify(views, null, 2)}`;
}

export function buildWriterContext(
  bible: StoryBible,
  control: StoryControl,
  plan: BatchPlan,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  nextChapter: number,
  batchSize: number,
  recentChapters: CreativeChapter[],
  continuityLock: InBatchContinuityLock = createEmptyInBatchContinuityLock()
): string {
  const requested = plan.chapters
    .map(chapter => chapter.chapterNumber)
    .filter(chapter => chapter >= nextChapter && chapter < nextChapter + batchSize);
  const chapters = requested.length ? requested : [nextChapter];
  const views = chapters.map(chapter => createWriterView(
    bible, control, plan, state, memoryIndex, chapter, recentChapters, continuityLock
  ));
  const projectionPayload = views.map(({ relevantMemories: _relevantMemories, ...view }) => view);
  const uniqueMemories = Array.from(new Map(views.flatMap(view => view.relevantMemories)
    .map(memory => [memory.id || `chapter_${memory.chapterNumber}`, memory])).values());
  // A single contract precedes every projected view, so scope it to the
  // earliest chapter and never reveal a term unlocked only later in the batch.
  const languageContract = createWriterOutputLanguageContract(control, bible, Math.min(...chapters));
  return `=== LONG-FORM STORY ENGINE V3: WRITER PROJECTION ===

${formatOutputLanguageContract(languageContract)}

${formatInBatchContinuityLock(continuityLock)}

[DANH SÁCH CẤM KỴ TUYỆT ĐỐI]
Các gate đã được cưỡng chế bằng projection dữ liệu; payload author-only/locked không được chuyển cho Writer.

${JSON.stringify(projectionPayload, null, 2)}

[KÝ ỨC CÁC CHƯƠNG LIÊN QUAN]
${formatMemoriesForContext(uniqueMemories)}`;
}

export function buildValidatorContext(
  control: StoryControl,
  plan: BatchPlan,
  state: StoryState,
  startChapter: number,
  output?: CreativeChapter[] | string,
  priorChapters: CreativeChapter[] = [],
  memoryIndex: ChapterMemory[] = []
): string {
  const generated = Array.isArray(output) ? output : [];
  const chapters = generated.length
    ? generated.map((chapter, index) => chapter.chapterNumber || startChapter + index)
    : [startChapter];
  let continuityLock = createEmptyInBatchContinuityLock();
  const views = chapters.map((chapter, index) => {
    const view = createValidatorView(
      control,
      plan,
      state,
      chapter,
      generated[index] || (typeof output === 'string' ? output : undefined),
      generated.filter((_, adjacentIndex) => adjacentIndex !== index),
      priorChapters.slice(-3),
      retrieveRelevantMemories(memoryIndex, {
        currentChapter: chapter,
        currentArcId: getArcForChapter(control, chapter).id,
        threadIds: state.unresolvedThreads,
        factIds: (state.knowledgeLedger || []).map(entry => entry.factId),
        seedIds: (state.longTermSeeds || []).filter(seed => seed.status !== 'resolved').map(seed => seed.id),
        injuryIds: Object.values(state.characterStates || {}).flatMap(character => character.injuries || [])
          .filter(injury => injury.status !== 'recovered').map(injury => injury.id || injury.type)
      }, 6)
    );
    const scoped = { ...view, inBatchContinuityLock: continuityLock };
    const generatedChapter = generated[index];
    const chapterPlan = plan.chapters.find(candidate => candidate.chapterNumber === chapter);
    if (generatedChapter && chapterPlan) continuityLock = extendInBatchContinuityLock(continuityLock, generatedChapter, chapterPlan);
    return scoped;
  });
  return `=== STORY ENGINE V3: CHAPTER-SCOPED VALIDATOR VIEWS ===\n${JSON.stringify(views, null, 2)}`;
}
