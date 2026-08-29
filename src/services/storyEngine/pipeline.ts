import { Character, CreativeChapter } from '../../types';
import {
  BatchPlan,
  ChapterMemory,
  PipelineProgressInfo,
  PipelineStage,
  StoryBible,
  StoryControl,
  StoryState,
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
import { makeStoryViolation } from './semanticValidator';
import { getStoryModelRoute } from './modelRouting';
import { compactMemoryIndex } from './memoryManager';

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
    onProgress = () => {},
    onLog = () => {}
  } = options;
  const nextChapter = existingChapters.length + 1;
  const requested = Array.from({ length: batchSize }, (_, index) => nextChapter + index);
  const targetEndChapter = requested[requested.length - 1];
  const hash = computeBibleHash(bible);
  const reportProgress = (stage: PipelineStage, message: string, progress: number, retryCount = 0) => {
    onProgress({ stage, message, progress, currentChapter: nextChapter, totalChapters: targetEndChapter, retryCount }, progress);
  };
  const fastRunner = aiFastRunner || (async (prompt: string) => prompt);
  const proRunner = aiProRunner || fastRunner;
  const roleRunner = (role: StoryModelRole) => {
    const route = getStoryModelRoute(role, { FAST: Boolean(aiFastRunner), QUALITY: Boolean(aiProRunner) });
    onLog(`[ModelRouting] role=${role} tier=${route.tier} status=${route.status}`);
    return route.tier === 'QUALITY' ? proRunner : fastRunner;
  };
  const semanticSource = aiSemanticRunner || aiProRunner;
  const semanticRunner = semanticSource
    ? (prompt: string, systemInstruction: string) => {
      const route = getStoryModelRoute('STORY_VALIDATOR_SEMANTIC', { QUALITY: true });
      onLog(`[ModelRouting] role=${route.role} tier=${route.tier} status=${route.status}`);
      return semanticSource(prompt, systemInstruction);
    }
    : undefined;

  reportProgress('compiler', 'Kiểm tra & biên dịch Story Control...', 10);
  const control = canReuseStoryControl(existingControl, hash)
    ? existingControl
    : await compileStoryControl(bible, prompt => roleRunner('STORY_CONTROL_COMPILER')(prompt, 'Story Control Compiler'));
  const currentState = canReuseDerivedState(existingState, control.sourceHash)
    ? existingState
    : { ...createInitialStoryState(control, existingChapters.length, bible.characters), continuitySummary: bible.continuitySummary };
  const currentMemories = compatibleMemories(existingMemories, control.sourceHash);
  let batchPlan = emptyBatchPlan(requested);
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
        (prompt, sys) => roleRunner('PLANNER')(prompt, sys),
        aiProRunner ? (prompt, sys) => roleRunner('PLAN_VALIDATOR_SEMANTIC')(prompt, sys) : undefined
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
  try {
    // No chapter is persisted here; all outputs remain local until the entire batch passes.
    for (const chapter of requested) {
      const chapterPlan = singleChapterPlan(batchPlan, chapter);
      const writerContext = buildWriterContext(
        bible, control, chapterPlan, currentState, currentMemories, chapter, 1,
        [...existingChapters, ...generatedChapters]
      );
      writerContexts.set(chapter, writerContext);
      const result = await generateChaptersProse(writerContext, chapterPlan, (prompt, sys) => roleRunner('WRITER')(prompt, sys));
      generatedChapters.push(...result.chapters);
      generatedCharacters.push(...result.newCharacters);
      if (result.storySummary) summaries.push(result.storySummary);
      rawOutputs.set(chapter, result.rawOutput);
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
    generatedChapters, batchPlan, control, currentState, bible, semanticRunner, existingChapters
  );
  onLog(`[Semantic QA] role=${validationResult.modelRole || 'semantic-validator'} attempts=${validationResult.attempts || 0} status=${validationResult.status} violations=${validationResult.violations.map(violation => `${violation.type}:${violation.severity}`).join(',') || 'none'}`);
  let repairCount = 0;
  const maxRepairs = 2;
  while (isRepairable(validationResult) && repairCount < maxRepairs) {
    repairCount++;
    reportProgress('repairing', `Auto Repair lượt ${repairCount}/${maxRepairs}...`, 80 + repairCount * 5, repairCount);
    let repairFailed = false;
    for (let index = 0; index < generatedChapters.length; index++) {
      const chapter = generatedChapters[index].chapterNumber || requested[index];
      const chapterViolations = validationResult.violations.filter(violation => {
        const violationChapter = violation.chapterNumber ?? violation.chapter;
        return violationChapter === undefined || violationChapter === chapter;
      });
      if (chapterViolations.length === 0) continue;
      try {
        const repaired = await repairBatchOutput(
          [generatedChapters[index]],
          rawOutputs.get(chapter) || '',
          chapterViolations,
          singleChapterPlan(batchPlan, chapter),
          writerContexts.get(chapter) || '',
          control,
          (prompt, sys) => roleRunner('AUTO_REPAIR')(prompt, sys)
        );
        generatedChapters[index] = repaired.chapters[0];
        rawOutputs.set(chapter, repaired.rawOutput);
      } catch (error) {
        repairFailed = true;
        onLog(`[Semantic Repair] attempt=${repairCount} chapter=${chapter} output=invalid error=${error instanceof Error ? error.name : 'Error'}`);
      }
    }
    if (repairFailed) continue;
    validationResult = await validateBatchOutput(
      generatedChapters, batchPlan, control, currentState, bible, semanticRunner, existingChapters
    );
    validationResult.repairAttempts = repairCount;
    onLog(`[Semantic QA] role=${validationResult.modelRole || 'semantic-validator'} attempts=${validationResult.attempts || 0} repairAttempt=${repairCount} status=${validationResult.status} violations=${validationResult.violations.map(violation => `${violation.type}:${violation.severity}`).join(',') || 'none'}`);
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
