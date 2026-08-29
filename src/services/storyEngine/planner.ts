import { CreativeChapter } from '../../types';
import { BatchPlan, ChapterMemory, ChapterPlan, StoryBible, StoryControl, StoryState } from './types';
import { buildPlannerContext } from './contextBuilder';
import { parseJsonObject, normalizePositiveInteger, normalizeStringArray, normalizeText } from './runtimeValidation';
import { validateBatchPlan, validateBatchPlanSemantically } from './planValidator';
import { getArcForChapter, getCharacterAccess } from './storyAccess';

export const MAX_PLAN_ATTEMPTS = 3;

export class PlanGenerationError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Plan không đạt sau ${MAX_PLAN_ATTEMPTS} lần thử: ${violations.join('; ')}`);
    this.name = 'PlanGenerationError';
    this.violations = violations;
  }
}

function normalizePacing(value: unknown): ChapterPlan['pacingTarget'] {
  return value === 'slow_build' || value === 'rising_action' || value === 'climax'
    || value === 'cliffhanger' || value === 'cool_down' ? value : 'rising_action';
}

function normalizeChapterPlan(value: unknown, fallbackChapter: number, control: StoryControl): ChapterPlan {
  const object = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const chapterNumber = normalizePositiveInteger(object.chapterNumber);
  if (chapterNumber === null) throw new Error(`ChapterPlan vị trí ${fallbackChapter} thiếu chapterNumber hợp lệ.`);
  const arcId = normalizeText(object.arcId);
  if (!arcId) throw new Error(`ChapterPlan Chương ${chapterNumber} thiếu arcId.`);
  const focus = normalizeText(object.focus) || normalizeText(object.primaryGoal) || 'Phát triển cốt truyện trong Arc hiện tại';
  const povCharacter = normalizeText(object.povCharacter) || '';
  return {
    chapterNumber,
    arcId,
    title: normalizeText(object.title) || `Chương ${chapterNumber}`,
    focus,
    primaryGoal: normalizeText(object.primaryGoal) || focus,
    secondaryGoal: normalizeText(object.secondaryGoal) || undefined,
    povCharacter,
    pacingTarget: normalizePacing(object.pacingTarget),
    requiredEvents: normalizeStringArray(object.requiredEvents),
    introducedCharacters: normalizeStringArray(object.introducedCharacters),
    activeCharacters: normalizeStringArray(object.activeCharacters),
    worldFactInteractions: normalizeStringArray(object.worldFactInteractions),
    cluesDiscovered: normalizeStringArray(object.cluesDiscovered),
    forbiddenSpoilers: [],
    plannedCharacters: normalizeStringArray(object.plannedCharacters).length
      ? normalizeStringArray(object.plannedCharacters) : normalizeStringArray(object.activeCharacters),
    plannedWorldFacts: normalizeStringArray(object.plannedWorldFacts).length
      ? normalizeStringArray(object.plannedWorldFacts) : normalizeStringArray(object.worldFactInteractions),
    plannedEvidence: normalizeStringArray(object.plannedEvidence),
    plannedInferences: normalizeStringArray(object.plannedInferences),
    mysteryAdvancement: normalizeText(object.mysteryAdvancement) || undefined,
    mysteryStageId: normalizeText(object.mysteryStageId) || undefined,
    conflict: normalizeText(object.conflict) || undefined,
    expectedOutcome: normalizeText(object.expectedOutcome) || undefined,
    continuityRequirements: normalizeStringArray(object.continuityRequirements),
    hookType: normalizeText(object.hookType) || undefined,
    majorFocusCharacter: normalizeText(object.majorFocusCharacter) || undefined,
    arcBeatIds: normalizeStringArray(object.arcBeatIds)
  };
}

export function normalizeBatchPlan(
  raw: string,
  control: StoryControl,
  requestedChapterNumbers: number[]
): BatchPlan {
  const parsed = parseJsonObject(raw, 'Planner output');
  if (!Array.isArray(parsed.chapters)) throw new Error('Planner output: chapters phải là array.');
  const chapters = parsed.chapters.map((chapter, index) =>
    normalizeChapterPlan(chapter, requestedChapterNumbers[index] ?? requestedChapterNumbers[0], control));
  const arcs = requestedChapterNumbers.map(chapter => getArcForChapter(control, chapter));
  return {
    arcId: arcs.every(arc => arc.id === arcs[0].id) ? arcs[0].id : `multi:${Array.from(new Set(arcs.map(arc => arc.id))).join(',')}`,
    startChapter: requestedChapterNumbers[0],
    endChapter: requestedChapterNumbers[requestedChapterNumbers.length - 1],
    requestedChapterNumbers: [...requestedChapterNumbers],
    chapters,
    batchDirectives: normalizeStringArray(parsed.batchDirectives),
    charactersGated: [],
    antiDriftMeasures: normalizeStringArray(parsed.antiDriftMeasures),
    planValid: true
  };
}

function deterministicPacing(control: StoryControl, chapter: number): ChapterPlan['pacingTarget'] {
  const arc = getArcForChapter(control, chapter);
  if (chapter === arc.climaxChapter) return 'climax';
  if (chapter > arc.climaxChapter) return 'cool_down';
  if (arc.pacing === 'slow_burn') return 'slow_build';
  return 'rising_action';
}

export function createDeterministicBatchPlan(
  _bible: StoryBible,
  control: StoryControl,
  requestedChapterNumbers: number[]
): BatchPlan {
  const chapters = requestedChapterNumbers.map(chapterNumber => {
    const arc = getArcForChapter(control, chapterNumber);
    const available = Object.values(control.characterRegistry || {}).filter(character =>
      getCharacterAccess(control, character, chapterNumber).canAppearDirectly);
    const pov = available.find(character => getCharacterAccess(control, character, chapterNumber).canUsePov);
    return {
      chapterNumber,
      arcId: arc.id,
      title: `Chương ${chapterNumber}: Tiến trình ${arc.title}`,
      focus: `Phát triển xung đột giai đoạn ${arc.title}`,
      primaryGoal: `Tiến triển mục tiêu của ${arc.id} tại Chương ${chapterNumber}`,
      povCharacter: pov?.name || '',
      pacingTarget: deterministicPacing(control, chapterNumber),
      requiredEvents: [],
      introducedCharacters: [],
      activeCharacters: pov ? [pov.name] : [],
      worldFactInteractions: [],
      cluesDiscovered: [],
      forbiddenSpoilers: [],
      plannedCharacters: pov ? [pov.name] : [],
      plannedWorldFacts: [],
      plannedEvidence: [],
      plannedInferences: [],
      continuityRequirements: [],
      arcBeatIds: []
    } satisfies ChapterPlan;
  });
  const arcIds = Array.from(new Set(chapters.map(chapter => chapter.arcId || '')));
  return {
    arcId: arcIds.length === 1 ? arcIds[0] : `multi:${arcIds.join(',')}`,
    startChapter: requestedChapterNumbers[0],
    endChapter: requestedChapterNumbers[requestedChapterNumbers.length - 1],
    requestedChapterNumbers: [...requestedChapterNumbers],
    chapters,
    batchDirectives: ['Tuân thủ đúng projection theo từng chương'],
    charactersGated: [],
    antiDriftMeasures: ['Không dùng beat ngoài Arc của từng chương'],
    planValid: true
  };
}

export async function generateBatchPlan(
  bible: StoryBible,
  control: StoryControl,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  nextChapter: number,
  batchSize: number,
  recentChapters: CreativeChapter[],
  runner: (prompt: string, sys: string) => Promise<string>,
  semanticRunner?: (prompt: string, sys: string) => Promise<string>
): Promise<BatchPlan> {
  const requestedChapterNumbers = Array.from({ length: batchSize }, (_, index) => nextChapter + index);
  const context = buildPlannerContext(bible, control, state, memoryIndex, nextChapter, batchSize, recentChapters);
  let feedback: string[] = [];

  for (let attempt = 1; attempt <= MAX_PLAN_ATTEMPTS; attempt++) {
    const sys = `Bạn là Story Engine V3 Chapter Planner. Lập đúng một ChapterPlan cho mỗi chương: [${requestedChapterNumbers.join(', ')}].
Mỗi ChapterPlan phải có chapterNumber, arcId, primaryGoal, povCharacter, plannedCharacters, plannedWorldFacts,
plannedEvidence, plannedInferences, continuityRequirements và pacingTarget. Không tự đổi số chương.
Trả duy nhất JSON object có trường chapters. Không dùng markdown.${feedback.length
  ? `\nPlan trước bị reject. Sửa toàn bộ violation sau:\n${feedback.join('\n')}` : ''}`;
    try {
      const raw = await runner(context, sys);
      const candidate = normalizeBatchPlan(raw, control, requestedChapterNumbers);
      const validation = validateBatchPlan(candidate, control, state, requestedChapterNumbers);
      if (validation.valid) {
        if (!semanticRunner) return validation.repairedPlan;
        const semantic = await validateBatchPlanSemantically(validation.repairedPlan, control, state, semanticRunner);
        if (semantic.valid) return validation.repairedPlan;
        feedback = [semantic.error || 'SEMANTIC_PLAN_REJECTED'];
        continue;
      }
      feedback = validation.errors;
    } catch (error) {
      feedback = [error instanceof Error ? error.message : String(error)];
    }
  }
  throw new PlanGenerationError(feedback);
}
