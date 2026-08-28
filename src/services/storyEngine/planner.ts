import { CreativeChapter } from '../../types';
import { StoryBible, StoryControl, StoryState, BatchPlan, ChapterPlan, ChapterMemory } from './types';
import { buildPlannerContext } from './contextBuilder';
import { getCurrentArc } from './arcController';
import { validateAndRepairBatchPlan } from './planValidator';

/**
 * Batch Planner V3:
 * Tạo Kế hoạch chi tiết từng chương cho Batch.
 * Sau khi AI Flash tạo kế hoạch, lập tức chạy qua `validateAndRepairBatchPlan`
 * để đảm bảo 100% không rò rỉ nhân vật bị khóa hoặc spoiler.
 */
export async function generateBatchPlan(
  bible: StoryBible,
  control: StoryControl,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  nextChapter: number,
  batchSize: number,
  recentChapters: CreativeChapter[],
  runner: (prompt: string, sys: string) => Promise<string>
): Promise<BatchPlan> {
  const currentArc = getCurrentArc(control, nextChapter);
  const context = buildPlannerContext(bible, control, state, memoryIndex, nextChapter, batchSize, recentChapters);

  const sys = `Bạn là BATCH PLANNER chuyên nghiệp cho hệ thống tiểu thuyết dài tập (Story Engine V3).
Nhiệm vụ: Lập kế hoạch vi mô cho ${batchSize} chương tiếp theo (từ Chương ${nextChapter} đến Chương ${nextChapter + batchSize - 1}).

QUY TẮC BẮT BUỘC:
1. Mỗi chương phải có trọng tâm rõ ràng (focus), không nhồi nhét quá nhiều xung đột.
2. TUYỆT ĐỐI KHÔNG đưa nhân vật đang bị khóa (gated) vào activeCharacters hoặc introducedCharacters.
3. TUYỆT ĐỐI KHÔNG tiết lộ các bí mật nằm trong danh sách cấm kỵ.
4. PacingTarget phải là 1 trong: "slow_build", "rising_action", "climax", "cliffhanger", "cool_down".
5. Trả về DUY NHẤT một JSON hợp lệ, không có code markdown phụ:
{
  "arcId": "${currentArc.id}",
  "startChapter": ${nextChapter},
  "endChapter": ${nextChapter + batchSize - 1},
  "batchDirectives": ["Chỉ thị 1 cho toàn batch", "Chỉ thị 2"],
  "antiDriftMeasures": ["Biện pháp chống chệch hướng"],
  "chapters": [
    {
      "chapterNumber": ${nextChapter},
      "title": "Tiêu đề chương",
      "focus": "Trọng tâm chính của chương",
      "povCharacter": "Tên nhân vật góc nhìn",
      "pacingTarget": "rising_action",
      "requiredEvents": ["Sự kiện 1", "Sự kiện 2"],
      "introducedCharacters": [],
      "activeCharacters": ["Tên các nhân vật tham gia"],
      "worldFactInteractions": ["Tương tác với hệ thống tu luyện/bối cảnh"],
      "cluesDiscovered": [],
      "forbiddenSpoilers": []
    }
  ]
}`;

  let candidatePlan: BatchPlan;

  try {
    const rawResult = await runner(context, sys);
    const cleaned = rawResult.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);

    if (parsed && Array.isArray(parsed.chapters) && parsed.chapters.length > 0) {
      candidatePlan = {
        arcId: currentArc.id,
        startChapter: nextChapter,
        endChapter: nextChapter + batchSize - 1,
        batchDirectives: Array.isArray(parsed.batchDirectives) ? parsed.batchDirectives : ['Bám sát Arc hiện tại'],
        charactersGated: [],
        antiDriftMeasures: Array.isArray(parsed.antiDriftMeasures) ? parsed.antiDriftMeasures : ['Không giải quyết xung đột sớm'],
        planValid: true,
        chapters: parsed.chapters.map((ch: any, idx: number) => ({
          chapterNumber: nextChapter + idx,
          title: ch.title || `Chương ${nextChapter + idx}`,
          focus: ch.focus || 'Phát triển cốt truyện',
          povCharacter: ch.povCharacter || (bible.characters?.[0]?.name || 'Nhân vật chính'),
          pacingTarget: ch.pacingTarget || 'rising_action',
          requiredEvents: Array.isArray(ch.requiredEvents) ? ch.requiredEvents : ['Diễn biến theo mạch'],
          introducedCharacters: Array.isArray(ch.introducedCharacters) ? ch.introducedCharacters : [],
          activeCharacters: Array.isArray(ch.activeCharacters) ? ch.activeCharacters : [(bible.characters?.[0]?.name || 'Nhân vật chính')],
          worldFactInteractions: Array.isArray(ch.worldFactInteractions) ? ch.worldFactInteractions : [],
          cluesDiscovered: Array.isArray(ch.cluesDiscovered) ? ch.cluesDiscovered : [],
          forbiddenSpoilers: Array.isArray(ch.forbiddenSpoilers) ? ch.forbiddenSpoilers : []
        }))
      };
    } else {
      throw new Error('Parsed plan has no valid chapters');
    }
  } catch (err) {
    console.warn('[generateBatchPlan] AI Planner failed or invalid output, generating deterministic plan:', err);
    candidatePlan = createDeterministicBatchPlan(bible, control, currentArc, nextChapter, batchSize);
  }

  // Chạy qua PlanValidator để kiểm tra & sửa tự động
  const validationResult = validateAndRepairBatchPlan(candidatePlan, control, state, nextChapter);
  return validationResult.repairedPlan;
}

/**
 * Deterministic Fallback Plan
 */
function createDeterministicBatchPlan(
  bible: StoryBible,
  control: StoryControl,
  currentArc: any,
  nextChapter: number,
  batchSize: number
): BatchPlan {
  const mainCharName = bible.characters?.[0]?.name || 'Nhân vật chính';
  const fallbackChapters: ChapterPlan[] = [];

  for (let i = 0; i < batchSize; i++) {
    const chNum = nextChapter + i;
    const isLastInBatch = i === batchSize - 1;
    fallbackChapters.push({
      chapterNumber: chNum,
      title: `Chương ${chNum}: Tiến trình ${currentArc.title}`,
      focus: `Phát triển xung đột giai đoạn ${currentArc.title}`,
      povCharacter: mainCharName,
      pacingTarget: isLastInBatch ? 'cliffhanger' : 'rising_action',
      requiredEvents: [
        `Khám phá và xử lý chướng ngại tại chương ${chNum}`,
        `Tương tác củng cố vị thế và năng lực`
      ],
      introducedCharacters: [],
      activeCharacters: [mainCharName],
      worldFactInteractions: ['Vận dụng quy tắc bối cảnh thế giới hiện có'],
      cluesDiscovered: [],
      forbiddenSpoilers: currentArc.forbiddenSpoilers || []
    });
  }

  return {
    arcId: currentArc.id,
    startChapter: nextChapter,
    endChapter: nextChapter + batchSize - 1,
    batchDirectives: ['Duy trì nhịp độ ổn định', 'Không giải quyết sớm đại cục'],
    charactersGated: [],
    antiDriftMeasures: ['Tuân thủ nghiêm ngặt Arc hiện tại'],
    planValid: true,
    chapters: fallbackChapters
  };
}
