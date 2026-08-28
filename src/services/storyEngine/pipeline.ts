import { Character, CreativeChapter } from '../../types';
import { StoryBible, StoryControl, StoryState, BatchPlan, ValidationResult, ChapterMemory, PipelineProgressInfo, PipelineStage } from './types';
import { compileStoryControl, computeBibleHash, createInitialStoryState } from './compiler';
import { generateBatchPlan } from './planner';
import { generateChaptersProse } from './writer';
import { validateBatchOutput } from './validator';
import { repairBatchOutput } from './autoRepair';
import { extractAndMergeState } from './stateExtractor';
import { buildWriterContext } from './contextBuilder';

export interface PipelineOptions {
  bible: StoryBible;
  existingControl?: StoryControl;
  existingState?: StoryState;
  existingMemories?: ChapterMemory[];
  existingChapters: CreativeChapter[];
  batchSize: number;
  aiFastRunner?: (prompt: string, sys?: string) => Promise<string>;
  aiProRunner?: (prompt: string, sys?: string) => Promise<string>;
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
  validationResult: ValidationResult;
  batchPlan: BatchPlan;
  repairCount: number;
  errorMessage?: string;
}

/**
 * Pipeline chính điều phối toàn bộ Long-Form Story Engine:
 * SETUP -> COMPILER -> ARC CONTROLLER -> CONTEXT BUILDER -> BATCH PLANNER -> WRITER -> VALIDATOR -> REPAIR -> STATE EXTRACTOR -> PERSIST
 */
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
    onProgress = () => {},
    onLog = () => {}
  } = options;

  const nextChapter = existingChapters.length + 1;
  const targetEndChapter = nextChapter + batchSize - 1;
  const hash = computeBibleHash(bible);

  const reportProgress = (stage: PipelineStage, message: string, progress: number, retryCount = 0) => {
    onProgress({
      stage,
      message,
      progress,
      currentChapter: nextChapter,
      totalChapters: targetEndChapter,
      retryCount
    }, progress);
  };

  // Helper runners
  const fastRunner = aiFastRunner || (async (p: string) => p);
  const proRunner = aiProRunner || fastRunner;

  // 1. STORY CONTROL COMPILER (Chỉ chạy lại nếu hash thay đổi hoặc chưa có control)
  reportProgress('compiler', 'Kiểm tra & Biên dịch Story Control...', 10);
  let control: StoryControl;

  if (existingControl && existingControl.sourceHash === hash && existingControl.arcs?.length > 0) {
    onLog('[Pipeline] Tái sử dụng StoryControl đã biên dịch (Hash khớp).');
    control = existingControl;
  } else {
    onLog('[Pipeline] Đang biên dịch StoryControl mới từ Bible thiết lập...');
    control = await compileStoryControl(bible, async (prompt) => {
      return fastRunner(prompt, 'Bạn là Story Control Compiler chuyên nghiệp.');
    });
    onLog(`[Pipeline] Đã biên dịch StoryControl: ${control.arcs.length} Arc, ${control.characterGates.length} Character Gate, ${control.spoilerGates.length} Spoiler Gate.`);
  }

  // 2. KHỞI TẠO HOẶC ĐỒNG BỘ STORY STATE
  const currentState: StoryState = existingState || createInitialStoryState(
    control,
    existingChapters.length,
    bible.characters
  );

  // 3. BATCH PLANNER (Flash model)
  reportProgress('planning', `Lập kế hoạch Batch (Chương ${nextChapter} - ${targetEndChapter})...`, 25);
  onLog(`[Pipeline] Đang lập Batch Plan cho ${batchSize} chương tiếp theo...`);

  const batchPlan = await generateBatchPlan(
    bible,
    control,
    currentState,
    existingMemories,
    nextChapter,
    batchSize,
    existingChapters,
    async (prompt, sys) => fastRunner(prompt, sys)
  );
  onLog(`[Pipeline] Đã duyệt Batch Plan: ${batchPlan.chapters.map(c => c.title).join(' | ')}`);

  // 4. WRITER (Sáng tác văn xuôi)
  reportProgress('writing', `Sáng tác văn xuôi các chương theo Batch Plan...`, 50);
  onLog(`[Pipeline] Đang tạo văn xuôi với mô hình chất lượng cao...`);

  const writerContext = buildWriterContext(
    bible,
    control,
    batchPlan,
    currentState,
    existingMemories,
    nextChapter,
    batchSize,
    existingChapters
  );

  const currentWriterResult = await generateChaptersProse(
    writerContext,
    batchPlan,
    async (prompt, sys) => proRunner(prompt, sys)
  );

  let generatedChapters = currentWriterResult.chapters;
  const newChars = currentWriterResult.newCharacters;
  const rawSummary = currentWriterResult.storySummary;

  // Nếu không tạo được chương nào
  if (generatedChapters.length === 0) {
    throw new Error('AI Writer không tạo được chương nào hợp lệ.');
  }

  // 5. VALIDATOR / QA & AUTO REPAIR LOOP
  reportProgress('validating', 'Hậu kiểm tính logic, Continuity & Pacing (QA)...', 75);
  onLog('[Pipeline] Đang thực hiện QA & Hậu kiểm các chương vừa viết...');

  let validationResult = await validateBatchOutput(
    generatedChapters,
    batchPlan,
    control,
    currentState,
    bible,
    async (prompt, sys) => fastRunner(prompt, sys)
  );

  let repairCount = 0;
  const MAX_REPAIRS = 2;

  while (!validationResult.pass && repairCount < MAX_REPAIRS) {
    repairCount++;
    reportProgress('repairing', `Tự động sửa lỗi QA (Lượt ${repairCount}/${MAX_REPAIRS})...`, 80 + repairCount * 5, repairCount);
    onLog(`[Pipeline] QA phát hiện vi phạm [${validationResult.violations.map(v => v.type).join(', ')}]. Đang kích hoạt Auto Repair lượt ${repairCount}...`);

    const repaired = await repairBatchOutput(
      generatedChapters,
      currentWriterResult.rawOutput,
      validationResult.violations,
      batchPlan,
      writerContext,
      async (prompt, sys) => proRunner(prompt, sys)
    );

    if (repaired.chapters.length > 0) {
      generatedChapters = repaired.chapters;
      currentWriterResult.rawOutput = repaired.rawOutput;

      // Re-validate sau khi sửa
      validationResult = await validateBatchOutput(
        generatedChapters,
        batchPlan,
        control,
        currentState,
        bible,
        async (prompt, sys) => fastRunner(prompt, sys)
      );

      if (validationResult.pass) {
        onLog(`[Pipeline] Auto Repair thành công ở lượt ${repairCount}! Đã vượt qua QA.`);
        break;
      }
    }
  }

  // Nếu sau 2 lượt sửa vẫn vi phạm nghiêm trọng
  if (!validationResult.pass) {
    reportProgress('failed', 'Hậu kiểm QA không đạt sau các lượt thử.', 100, repairCount);
    onLog(`[Pipeline] CẢNH BÁO: Bản thảo không vượt qua QA sau ${MAX_REPAIRS} lượt sửa.`);
    return {
      success: false,
      acceptedChapters: [],
      nextState: currentState,
      nextControl: control,
      newCharacters: [],
      updatedContinuitySummary: bible.continuitySummary || '',
      newMemories: [],
      validationResult,
      batchPlan,
      repairCount,
      errorMessage: `Hậu kiểm QA không đạt: ${validationResult.violations.map(v => v.reason).join('; ')}`
    };
  }

  // 6. STATE EXTRACTOR (Chỉ chạy sau khi QA Pass)
  reportProgress('extracting', 'Cập nhật trạng thái câu chuyện & Ký ức...', 92);
  onLog('[Pipeline] Đang trích xuất State Delta và cập nhật StoryState...');

  const extracted = await extractAndMergeState(
    generatedChapters,
    currentState,
    control,
    [...(bible.characters || []), ...newChars],
    rawSummary,
    nextChapter,
    async (prompt, sys) => fastRunner(prompt, sys)
  );

  reportProgress('completed', 'Hoàn tất lượt viết!', 100);
  onLog(`[Pipeline] Hoàn tất thành công! Đã thêm ${generatedChapters.length} chương mới vào tác phẩm.`);

  return {
    success: true,
    acceptedChapters: generatedChapters,
    nextState: extracted.nextState,
    nextControl: control,
    newCharacters: [...newChars, ...extracted.newCharacters],
    updatedContinuitySummary: extracted.updatedContinuitySummary,
    newMemories: extracted.newMemories,
    validationResult,
    batchPlan,
    repairCount
  };
}
