import { Character, CreativeChapter } from '../../types';
import {
  BatchPlan,
  ChapterMemory,
  PipelineProgressInfo,
  PipelineStage,
  StoryBible,
  StoryControl,
  StoryState,
  StoryModelTier,
  ValidationResult,
  STORY_CONTROL_SCHEMA_VERSION,
  STORY_STATE_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION,
  StoryModelRole
} from './types';
import { compileStoryControl, computeBibleHash, createInitialStoryState } from './compiler';
import { generateBatchPlan } from './planner';
import { generateChaptersProse } from './writer';
import { validateBatchOutput } from './validator';
import { repairBatchOutput } from './autoRepair';
import { extractAndMergeState } from './stateExtractor';
import { buildWriterContext } from './contextBuilder';
import { splitChaptersByArc, validateArcRanges } from './storyAccess';
import { makeStoryViolation, qaUnavailableResult } from './semanticValidator';
import { getStoryModelRoute } from './modelRouting';
import { compactMemoryIndex } from './memoryManager';
import { formatSemanticQaDiagnosticLines } from './diagnostics';
import { createWriterOutputLanguageContract } from './languageContract';
import { createEmptyInBatchContinuityLock, extendInBatchContinuityLock } from './continuityLock';
import { getChapterPacingTarget, normalizeStoryControlPacing } from './pacingContract';

export interface PipelineOptions {
  bible: StoryBible;
  existingControl?: StoryControl;
  existingState?: StoryState;
  existingMemories?: ChapterMemory[];
  existingChapters: CreativeChapter[];
  batchSize: number;
  aiFastRunner?: (prompt: string, sys?: string) => Promise<string>;
  aiProRunner?: (prompt: string, sys?: string) => Promise<string>;
  aiSemanticRunner?: (prompt: string, sys?: string) => Promise<string>;
  aiRoleRunner?: (role: StoryModelRole, prompt: string, sys?: string, signal?: AbortSignal) => Promise<string>;
  /** Cancellation is authoritative: no result can be accepted after it aborts. */
  signal?: AbortSignal;
  storyModelAvailability?: Partial<Record<StoryModelTier, boolean>>;
  onProgress?: (info: PipelineProgressInfo | string, progressPercent?: number) => void;
  onLog?: (message: string) => void;
}

export interface PipelineResult {
  success: boolean;
  acceptedChapters: CreativeChapter[];
  nextState: StoryState;
  nextControl: StoryControl;
  newCharacters: Character[];
  updatedContinuitySummary: string;
  newMemories: ChapterMemory[];
  nextMemories: ChapterMemory[];
  validationResult: ValidationResult;
  batchPlan: BatchPlan;
  repairCount: number;
  errorMessage?: string;
}

const abortError = () => Object.assign(new Error('Story generation was cancelled.'), { name: 'AbortError' });
const throwIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw abortError(); };

/** Reject torn canon before a single model request. Empty/fresh and legacy-compatible tuples remain valid. */
export function validateStoryPipelineBaseline(
  chapters: CreativeChapter[], state: StoryState | undefined, memories: ChapterMemory[],
): void {
  // Pre-V3 imports did not persist chapterNumber; their array order is the
  // canonical contiguous sequence until the next accepted commit writes IDs.
  const numbers = chapters.map((chapter, index) => chapter.chapterNumber ?? index + 1);
  if (numbers.some(number => !Number.isInteger(number)) || new Set(numbers).size !== numbers.length
    || numbers.some((number, index) => number !== index + 1)) throw new Error('Story canon preflight failed: chapters must be unique and contiguous from chapter 1.');
  const last = numbers.length;
  if (state && state.currentChapter !== last) throw new Error('Story canon preflight failed: StoryState.currentChapter does not match committed chapters.');
  const memoryIds = new Set<string>();
  const memoryRanges = new Set<string>();
  for (const memory of memories) {
    const start = memory.chapterStart ?? memory.chapterNumber;
    const end = memory.chapterEnd ?? memory.chapterNumber;
    const range = `${start}:${end}`;
    if (!memory.id || memoryIds.has(memory.id) || memoryRanges.has(range) || !Number.isInteger(start) || !Number.isInteger(end)
      || start < 1 || end < start || end > last) {
      throw new Error('Story canon preflight failed: memory index is duplicate, future, or malformed.');
    }
    memoryIds.add(memory.id);
    memoryRanges.add(range);
  }
}

export function canReuseStoryControl(control: StoryControl | undefined, expectedHash: string): control is StoryControl {
  return Boolean(control
    && control.schemaVersion === STORY_CONTROL_SCHEMA_VERSION
    && control.sourceHash === expectedHash
    && control.arcs?.length > 0);
}

export function canReuseDerivedState(state: StoryState | undefined, expectedHash: string): state is StoryState {
  return Boolean(state && state.schemaVersion === STORY_STATE_SCHEMA_VERSION && state.sourceHash === expectedHash);
}

export function compatibleMemories(memories: ChapterMemory[] | undefined, expectedHash: string): ChapterMemory[] {
  return (memories || []).filter(memory => memory.schemaVersion === MEMORY_SCHEMA_VERSION && memory.sourceHash === expectedHash);
}

function structuralFailure(message: string, chapter: number): ValidationResult {
  return {
    pass: false,
    status: 'FAIL',
    continuityScore: 0,
    pacingScore: 0,
    violations: [makeStoryViolation({
      type: 'OUTPUT_STRUCTURE',
      severity: 'CRITICAL',
      chapterNumber: chapter,
      message,
      suggestedRepair: 'Fix the planning/output contract and rerun the entire batch.'
    })],
    warnings: [],
    semanticChecks: {
      characterGating: false,
      worldFactContinuity: false,
      spoilerContainment: false,
      pacingIntegrity: false,
      characterTraitConsistency: false
    }
  };
}

function stateIntegrationFailure(chapter: number): ValidationResult {
  return {
    ...structuralFailure('Critical state integration failed; no persistent update was applied.', chapter),
    violations: [makeStoryViolation({
      type: 'STATE_DELTA_INVALID',
      severity: 'CRITICAL',
      chapterNumber: chapter,
      message: 'Critical state integration failed after QA; the entire batch was discarded.',
      suggestedRepair: 'Retry state integration from the last fully persisted project snapshot.'
    })]
  };
}

function isRepairable(result: ValidationResult): boolean {
  if (result.status !== 'FAIL') return false;
  if (result.violations.some(violation => violation.severity === 'CRITICAL')) return false;
  return result.violations.some(violation => violation.severity === 'MEDIUM' || violation.severity === 'HIGH');
}

function logSemanticQaResult(
  result: ValidationResult,
  control: StoryControl,
  onLog: (message: string) => void,
  repairAttempt?: number
): void {
  const repairSuffix = repairAttempt === undefined ? '' : ` repairAttempt=${repairAttempt}`;
  onLog(`[Semantic QA] role=${result.modelRole || 'semantic-validator'} attempts=${result.attempts || 0}${repairSuffix} status=${result.status} violations=${result.violations.map(violation => `${violation.type}:${violation.severity}`).join(',') || 'none'}`);
  if (result.status === 'PASS') return;
  for (const detail of formatSemanticQaDiagnosticLines(result, control)) onLog(detail);
}

function validationFailureMessage(result: ValidationResult, repairCount: number, maxRepairs: number): string {
  if (result.status === 'QA_UNAVAILABLE') {
    return 'Không thể hoàn tất kiểm định chất lượng; chương chưa được lưu.';
  }
  if (repairCount >= maxRepairs) {
    return 'Đã thử sửa nhưng chương vẫn chưa đạt kiểm định.';
  }
  return 'Chương chưa đạt kiểm định chất lượng.';
}

function emptyBatchPlan(chapters: number[]): BatchPlan {
  return {
    arcId: '',
    startChapter: chapters[0],
    endChapter: chapters[chapters.length - 1],
    requestedChapterNumbers: [...chapters],
    chapters: [],
    batchDirectives: [],
    charactersGated: [],
    antiDriftMeasures: [],
    planValid: false
  };
}

function mergePlans(plans: BatchPlan[], requested: number[]): BatchPlan {
  const chapters = plans.flatMap(plan => plan.chapters).sort((a, b) => a.chapterNumber - b.chapterNumber);
  const arcIds = Array.from(new Set(chapters.map(chapter => chapter.arcId || '')));
  return {
    arcId: arcIds.length === 1 ? arcIds[0] : `multi:${arcIds.join(',')}`,
    startChapter: requested[0],
    endChapter: requested[requested.length - 1],
    requestedChapterNumbers: [...requested],
    chapters,
    batchDirectives: plans.flatMap(plan => plan.batchDirectives),
    charactersGated: Array.from(new Set(plans.flatMap(plan => plan.charactersGated))),
    antiDriftMeasures: Array.from(new Set(plans.flatMap(plan => plan.antiDriftMeasures))),
    planValid: plans.every(plan => plan.planValid)
  };
}

function singleChapterPlan(plan: BatchPlan, chapter: number): BatchPlan {
  const chapterPlan = plan.chapters.find(candidate => candidate.chapterNumber === chapter);
  if (!chapterPlan) throw new Error(`Thiếu ChapterPlan cho Chương ${chapter}.`);
  return {
    ...plan,
    arcId: chapterPlan.arcId || plan.arcId,
    startChapter: chapter,
    endChapter: chapter,
    requestedChapterNumbers: [chapter],
    chapters: [chapterPlan]
  };
}

function failResult(
  message: string,
  chapter: number,
  control: StoryControl,
  state: StoryState,
  bible: StoryBible,
  batchPlan: BatchPlan,
  repairCount = 0,
  validationResult = structuralFailure(message, chapter)
): PipelineResult {
  return {
    success: false,
    acceptedChapters: [],
    nextState: state,
    nextControl: control,
    newCharacters: [],
    updatedContinuitySummary: bible.continuitySummary || '',
    newMemories: [],
    nextMemories: [],
    validationResult,
    batchPlan,
    repairCount,
    errorMessage: message
  };
}

export async function runStoryEnginePipeline(options: PipelineOptions): Promise<PipelineResult> {
  const {
    bible,
    existingControl,
    existingState,
    existingMemories = [],
    existingChapters,
    batchSize,
    aiFastRunner,
    aiProRunner,
    aiSemanticRunner,
    aiRoleRunner,
    signal,
    storyModelAvailability,
    onProgress = () => {},
    onLog = () => {}
  } = options;
  throwIfAborted(signal);
  validateStoryPipelineBaseline(existingChapters, existingState, existingMemories);
  const nextChapter = existingChapters.length + 1;
  const requested = Array.from({ length: batchSize }, (_, index) => nextChapter + index);
  const targetEndChapter = requested[requested.length - 1];
  const hash = computeBibleHash(bible);
  const reportProgress = (stage: PipelineStage, message: string, progress: number, retryCount = 0) => {
    onProgress({ stage, message, progress, currentChapter: nextChapter, totalChapters: targetEndChapter, retryCount }, progress);
  };
  const availability: Partial<Record<StoryModelTier, boolean>> = storyModelAvailability || {
    FAST: Boolean(aiRoleRunner || aiFastRunner),
    QUALITY: Boolean(aiRoleRunner || aiProRunner)
  };
  const qualityAvailable = availability.QUALITY === true;
  const fastRunner = aiFastRunner || (async () => {
    throw new Error('FAST runner is unavailable; prompt echo is prohibited.');
  });
  const roleRunner = (role: StoryModelRole) => {
    const route = getStoryModelRoute(role, availability);
    onLog(`[ModelRouting] role=${role} tier=${route.tier} status=${route.status}`);
    if (aiRoleRunner && availability[route.tier] === true) {
      return async (prompt: string, sys?: string, attemptSignal?: AbortSignal) => { throwIfAborted(signal); const value = await aiRoleRunner(role, prompt, sys, attemptSignal); throwIfAborted(signal); return value; };
    }
    if (route.tier === 'QUALITY') {
      if (aiProRunner) return async (prompt: string, sys?: string) => { throwIfAborted(signal); const value = await aiProRunner(prompt, sys); throwIfAborted(signal); return value; };
      if (route.allowFastFallback && aiFastRunner) return async (prompt: string, sys?: string) => { throwIfAborted(signal); const value = await aiFastRunner(prompt, sys); throwIfAborted(signal); return value; };
      throw new Error(`Required QUALITY runner is unavailable for ${role}; FAST fallback is not permitted.`);
    }
    return async (prompt: string, sys?: string) => { throwIfAborted(signal); const value = await fastRunner(prompt, sys); throwIfAborted(signal); return value; };
  };
  const semanticRunner = aiSemanticRunner || qualityAvailable
    ? (prompt: string, systemInstruction: string, attemptSignal?: AbortSignal) => {
      if (aiSemanticRunner) {
        const route = getStoryModelRoute('STORY_VALIDATOR_SEMANTIC', { QUALITY: true });
        onLog(`[ModelRouting] role=${route.role} tier=${route.tier} status=${route.status}`);
        return Promise.resolve().then(async () => { throwIfAborted(signal); const value = await aiSemanticRunner(prompt, systemInstruction); throwIfAborted(signal); return value; });
      }
      return roleRunner('STORY_VALIDATOR_SEMANTIC')(prompt, systemInstruction, attemptSignal);
    }
    : undefined;

  reportProgress('compiler', 'Kiểm tra & biên dịch Story Control...', 10);
  const rawControl = canReuseStoryControl(existingControl, hash)
    ? existingControl
    : await compileStoryControl(bible, prompt => roleRunner('STORY_CONTROL_COMPILER')(prompt, 'Story Control Compiler'));
  const control = normalizeStoryControlPacing(rawControl);
  const currentState = canReuseDerivedState(existingState, control.sourceHash)
    ? existingState
    : { ...createInitialStoryState(control, existingChapters.length, bible.characters), continuitySummary: bible.continuitySummary };
  const currentMemories = compatibleMemories(existingMemories, control.sourceHash);
  let batchPlan = emptyBatchPlan(requested);
  if (!qualityAvailable) {
    const validation = qaUnavailableResult(0, 'Required QUALITY model roles are unavailable; FAST fallback is not permitted.');
    return failResult('Không có model QUALITY hợp lệ; batch chưa được tạo hoặc lưu.', nextChapter, control, currentState, bible, batchPlan, 0, validation);
  }
  try {
    validateArcRanges(control);
    const segments = splitChaptersByArc(control, requested);
    onLog(`[Pipeline] Arc segments: ${segments.map(segment => `${segment.arc.id}[${segment.chapterNumbers.join(',')}]`).join(' | ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failResult(message, nextChapter, control, currentState, bible, batchPlan);
  }

  reportProgress('planning', `Lập ChapterPlan cho Chương ${nextChapter}-${targetEndChapter}...`, 25);
  const plans: BatchPlan[] = [];
  try {
    // Chapter-isolated calls prevent a plan for an earlier chapter from seeing a later gate/arc projection.
    for (const chapter of requested) {
      plans.push(await generateBatchPlan(
        bible, control, currentState, currentMemories, chapter, 1, existingChapters,
        (prompt, sys, attemptSignal) => roleRunner('PLANNER')(prompt, sys, attemptSignal),
        qualityAvailable ? (prompt, sys, attemptSignal) => roleRunner('PLAN_VALIDATOR_SEMANTIC')(prompt, sys, attemptSignal) : undefined,
        signal
      ));
    }
    batchPlan = mergePlans(plans, requested);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportProgress('failed', message, 100);
    return failResult(message, nextChapter, control, currentState, bible, batchPlan);
  }

  reportProgress('writing', 'Sáng tác văn xuôi theo từng Writer View cô lập...', 50);
  const generatedChapters: CreativeChapter[] = [];
  const generatedCharacters: Character[] = [];
  const summaries: string[] = [];
  const writerContexts = new Map<number, string>();
  const rawOutputs = new Map<number, string>();
  let continuityLock = createEmptyInBatchContinuityLock();
  const pacingTarget = getChapterPacingTarget(control);
  const writerContract = {
    minimumWords: pacingTarget.min,
    idealWords: pacingTarget.ideal,
    maximumWords: pacingTarget.max,
    softMinimumWords: pacingTarget.soft,
    neverPadWithFiller: pacingTarget.neverPadWithFiller
  };
  try {
    // No chapter is persisted here; all outputs remain local until the entire batch passes.
    for (const chapter of requested) {
      const chapterPlan = singleChapterPlan(batchPlan, chapter);
      const writerContext = buildWriterContext(
        bible, control, chapterPlan, currentState, currentMemories, chapter, 1,
        [...existingChapters, ...generatedChapters], continuityLock
      );
      writerContexts.set(chapter, writerContext);
      const result = await generateChaptersProse(
        writerContext,
        chapterPlan,
        (prompt, sys) => roleRunner('WRITER')(prompt, sys),
        { ...writerContract, outputLanguage: createWriterOutputLanguageContract(control, bible, chapter) }
      );
      generatedChapters.push(...result.chapters);
      generatedCharacters.push(...result.newCharacters);
      if (result.storySummary) summaries.push(result.storySummary);
      rawOutputs.set(chapter, result.rawOutput);
      continuityLock = extendInBatchContinuityLock(continuityLock, result.chapters[0], chapterPlan.chapters[0]);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportProgress('failed', message, 100);
    return failResult(message, nextChapter, control, currentState, bible, batchPlan);
  }

  const actualNumbers = generatedChapters.map(chapter => chapter.chapterNumber);
  if (actualNumbers.length !== requested.length || requested.some(chapter => !actualNumbers.includes(chapter))) {
    return failResult(`Writer aggregate không chứa exact requested chapters [${requested.join(', ')}].`, nextChapter, control, currentState, bible, batchPlan);
  }

  reportProgress('validating', 'Hậu kiểm logic, continuity & pacing...', 75);
  let validationResult = await validateBatchOutput(
    generatedChapters, batchPlan, control, currentState, bible, semanticRunner, existingChapters, signal
  );
  logSemanticQaResult(validationResult, control, onLog);
  let repairCount = 0;
  const maxRepairs = 2;
  while (isRepairable(validationResult) && repairCount < maxRepairs) {
    repairCount++;
    reportProgress('repairing', `Auto Repair lượt ${repairCount}/${maxRepairs}...`, 80 + repairCount * 5, repairCount);
    let repairFailed = false;
    const repairSnapshot = [...generatedChapters];
    for (let index = 0; index < generatedChapters.length; index++) {
      const chapter = generatedChapters[index].chapterNumber || requested[index];
      const chapterViolations = validationResult.violations.filter(violation => {
        const violationChapter = violation.chapterNumber ?? violation.chapter;
        return violationChapter === undefined || violationChapter === chapter;
      });
      if (chapterViolations.length === 0) continue;
      try {
        let repairLock = createEmptyInBatchContinuityLock();
        for (const prior of generatedChapters) {
          const priorNumber = prior.chapterNumber || 0;
          if (priorNumber >= chapter) break;
          const priorPlan = batchPlan.chapters.find(candidate => candidate.chapterNumber === priorNumber);
          if (priorPlan) repairLock = extendInBatchContinuityLock(repairLock, prior, priorPlan);
        }
        const repairWriterContext = buildWriterContext(
          bible,
          control,
          singleChapterPlan(batchPlan, chapter),
          currentState,
          currentMemories,
          chapter,
          1,
          [...existingChapters, ...generatedChapters.filter(candidate => (candidate.chapterNumber || 0) < chapter)],
          repairLock
        );
        writerContexts.set(chapter, repairWriterContext);
        const repaired = await repairBatchOutput(
          [generatedChapters[index]],
          rawOutputs.get(chapter) || '',
          chapterViolations,
          singleChapterPlan(batchPlan, chapter),
          repairWriterContext,
          control,
          (prompt, sys) => roleRunner('AUTO_REPAIR')(prompt, sys),
          bible
        );
        generatedChapters[index] = repaired.chapters[0];
        rawOutputs.set(chapter, repaired.rawOutput);
      } catch (error) {
        repairFailed = true;
        onLog(`[Semantic Repair] attempt=${repairCount} chapter=${chapter} output=invalid error=${error instanceof Error ? error.name : 'Error'}`);
      }
    }
    if (repairFailed) { generatedChapters.splice(0, generatedChapters.length, ...repairSnapshot); continue; }
    validationResult = await validateBatchOutput(
      generatedChapters, batchPlan, control, currentState, bible, semanticRunner, existingChapters, signal
    );
    validationResult.repairAttempts = repairCount;
    logSemanticQaResult(validationResult, control, onLog, repairCount);
  }
  if (!validationResult.pass) {
    const message = validationFailureMessage(validationResult, repairCount, maxRepairs);
    onLog(`[Pipeline] QA rejected batch: status=${validationResult.status}; repairAttempts=${repairCount}; chapters=[${requested.join(',')}]`);
    return failResult(message, nextChapter, control, currentState, bible, batchPlan, repairCount, validationResult);
  }

  reportProgress('extracting', 'Cập nhật StoryState và memory...', 92);
  let extracted: Awaited<ReturnType<typeof extractAndMergeState>>;
  try {
    extracted = await extractAndMergeState(
      generatedChapters,
      currentState,
      control,
      [...(bible.characters || []), ...generatedCharacters],
      summaries.join(' '),
      nextChapter,
      (prompt, sys) => roleRunner('STATE_EXTRACTOR')(prompt, sys)
    );
  } catch {
    const message = 'Không thể tích hợp trạng thái an toàn; toàn bộ batch đã bị hủy.';
    reportProgress('failed', message, 100);
    onLog(`[Pipeline] Critical state integration failed; discarded chapters=[${requested.join(',')}].`);
    return failResult(message, nextChapter, control, currentState, bible, batchPlan, repairCount,
      stateIntegrationFailure(nextChapter));
  }
  const nextMemories = compactMemoryIndex([...currentMemories, ...extracted.newMemories], 240, extracted.nextState);
  reportProgress('completed', 'Hoàn tất lượt viết!', 100);
  return {
    success: true,
    acceptedChapters: generatedChapters,
    nextState: extracted.nextState,
    nextControl: control,
    newCharacters: [...generatedCharacters, ...extracted.newCharacters],
    updatedContinuitySummary: extracted.updatedContinuitySummary,
    newMemories: extracted.newMemories,
    nextMemories,
    validationResult,
    batchPlan,
    repairCount
  };
}
