import { CreativeChapter } from '../../types';
import { StoryBible, StoryControl, StoryState, BatchPlan, ChapterMemory } from './types';
import { getCurrentArc, calculateArcProgress, filterCharactersForChapter, filterSpoilersForChapter, getTransitionPreview } from './arcController';
import { retrieveRelevantMemories, formatMemoriesForContext } from './memoryManager';

/**
 * 1. PLANNER CONTEXT PROJECTION:
 * Nhìn thấy Arc hiện tại, các milestone của Arc, các nhân vật đã unlock và nhân vật sắp mở khóa.
 */
export function buildPlannerContext(
  bible: StoryBible,
  control: StoryControl,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  nextChapter: number,
  batchSize: number,
  recentChapters: CreativeChapter[]
): string {
  const currentArc = getCurrentArc(control, nextChapter);
  const { arcProgress, isNearClimax } = calculateArcProgress(currentArc, nextChapter);

  const { activeCharacters, lockedCharacters } = filterCharactersForChapter(
    bible.characters || [],
    control.characterGates || [],
    nextChapter,
    control
  );

  const { allowedReveals, forbiddenSpoilers } = filterSpoilersForChapter(
    control.spoilerGates || [],
    nextChapter
  );

  const transitionPreview = getTransitionPreview(control, currentArc, nextChapter);

  // Ký ức liên quan
  const relevantMems = retrieveRelevantMemories(
    memoryIndex,
    activeCharacters.map(c => c.name),
    nextChapter,
    4
  );

  // World facts khả dụng
  const activeFacts = (control.worldFacts || []).filter(f => f.introducedAtChapter <= nextChapter);

  // Recent prose summary (chương gần nhất)
  const lastChapter = recentChapters.length > 0 ? recentChapters[recentChapters.length - 1] : null;
  const lastChapterSnippet = lastChapter
    ? `Chương ${recentChapters.length}: "${lastChapter.title}"\n${lastChapter.content.slice(-600)}`
    : 'Chưa có chương nào được viết (Điểm bắt đầu tác phẩm).';

  return `=== LONG-FORM STORY ENGINE V3: PLANNER CONTEXT ===
Tác phẩm: ${bible.seedTitle} | Thể loại: ${bible.genre}
Lập kế hoạch: Chương ${nextChapter} -> Chương ${nextChapter + batchSize - 1} (${batchSize} chương)

[CANON PREMISE]
${bible.seriesPremise || bible.continuitySummary || 'Chưa thiết lập.'}

[GIAI ĐOẠN HIỆN TẠI: ${currentArc.id.toUpperCase()}]
- Tiêu đề: ${currentArc.title} (Chương ${currentArc.startChapter} - ${currentArc.endChapter})
- Tiến độ: ${Math.round(arcProgress * 100)}% ${isNearClimax ? '[GẦN CAO TRÀO HỒI]' : '[ĐANG TRIỂN KHAI]'}
- Chủ đề: ${currentArc.theme}
- Mâu thuẫn cốt lõi: ${currentArc.coreConflict}
- Cột mốc kế hoạch: ${(currentArc.keyMilestones || []).join('; ')}

[QUY TẮC PHƠI BÀY THÔNG TIN & SPOILER GATES]
- Bí mật cấm lộ: ${forbiddenSpoilers.map(s => s.description).concat(currentArc.forbiddenSpoilers || []).join('; ') || 'Không có'}
- Bí mật được phép hé lộ: ${allowedReveals.map(s => s.description).join('; ') || 'Không có'}

${transitionPreview ? `\n${transitionPreview}\n` : ''}

[NHÂN VẬT ĐƯỢC PHÉP THAM GIA]
${activeCharacters.map(c => `- ${c.name} (${c.role || 'Nhân vật'}, ${c.gender || ''}): ${c.personality || ''}`).join('\n')}

[NHÂN VẬT BỊ KHÓA (GATED - CẤM ĐƯA VÀO KẾ HOẠCH)]
${lockedCharacters.map(l => `- ${l.characterName} (Chỉ mở khóa từ chương ${l.unlockAtChapter})`).join('\n') || 'Không có'}

[QUY TẮC THẾ GIỚI KHẢ DỤNG]
${activeFacts.map(f => `- [${f.category}] ${f.fact}`).join('\n') || 'Tuân thủ logic tu luyện/bối cảnh chung.'}

[TRẠNG THÁI TỒN ĐỌNG (STATE CONTINUITY)]
${state.unresolvedThreads?.length ? `Vấn đề chưa giải quyết: ${state.unresolvedThreads.join('; ')}` : 'Không có'}
${(state.clues || []).filter(c => !c.resolved).map(c => `Manh mối: ${c.clue}`).join('; ')}

[KÝ ỨC CÁC CHƯƠNG GẦN NHẤT]
${formatMemoriesForContext(relevantMems)}

[ĐOẠN KẾT CHƯƠNG TRƯỚC ĐÓ]
${lastChapterSnippet}
`;
}

/**
 * 2. WRITER CONTEXT PROJECTION (STRICT):
 * Tuyệt đối không chứa spoiler tương lai, không chứa nhân vật bị khóa, chỉ chứa facts đã công bố.
 */
export function buildWriterContext(
  bible: StoryBible,
  control: StoryControl,
  plan: BatchPlan,
  state: StoryState,
  memoryIndex: ChapterMemory[],
  nextChapter: number,
  batchSize: number,
  recentChapters: CreativeChapter[]
): string {
  const currentArc = getCurrentArc(control, nextChapter);
  const { arcProgress } = calculateArcProgress(currentArc, nextChapter);

  const { activeCharacters, lockedCharacters } = filterCharactersForChapter(
    bible.characters || [],
    control.characterGates || [],
    nextChapter,
    control
  );

  const { forbiddenSpoilers } = filterSpoilersForChapter(
    control.spoilerGates || [],
    nextChapter
  );

  // Ký ức liên quan
  const relevantMems = retrieveRelevantMemories(
    memoryIndex,
    activeCharacters.map(c => c.name),
    nextChapter,
    4
  );

  // Lấy các thương tích chưa hồi phục
  const activeInjuries = Object.values(state.characterStates || {}).flatMap(cs =>
    (cs.injuries || [])
      .filter(inj => inj.expectedRecoveryChapter > nextChapter)
      .map(inj => `- ${cs.name}: ${inj.type} ở ${inj.bodyPart} (${inj.restrictions?.join(', ') || 'Đau đớn, hạn chế'}). Phải phản ánh trong hành động!`)
  );

  // Manh mối đã biết (CHỈ đưa clue, TUYỆT ĐỐI KHÔNG đưa actualTruthHidden)
  const knownClues = (state.clues || [])
    .filter(c => !c.resolved)
    .map(c => `- Manh mối: "${c.clue}" (Phát hiện ch${c.discoveredChapter}). Suy đoán: ${c.knownInterpretations?.join('; ') || 'Chưa rõ'}`);

  // World facts đã được biết
  const activeFacts = (control.worldFacts || [])
    .filter(f => f.introducedAtChapter <= nextChapter && f.scope !== 'hidden_truth')
    .map(f => `- ${f.fact}`);

  // Last chapter ending
  const lastChapter = recentChapters.length > 0 ? recentChapters[recentChapters.length - 1] : null;
  const lastChapterText = lastChapter
    ? `=== ĐOẠN KẾT CHƯƠNG ${recentChapters.length} ("${lastChapter.title}") ===\n${lastChapter.content.slice(-1000)}`
    : '=== ĐÂY LÀ CHƯƠNG 1 (MỞ ĐẦU TÁC PHẨM) ===';

  return `=== LONG-FORM STORY ENGINE V3: WRITER PROJECTION ===
Tác phẩm: ${bible.seedTitle} | Thể loại: ${bible.genre}
Tiến trình viết: Chương ${nextChapter} -> Chương ${nextChapter + batchSize - 1}
Hồi (Arc): ${currentArc.title} (Tiến độ ${Math.round(arcProgress * 100)}%)

[PREMISE BẤT BIẾN]
${bible.seriesPremise || bible.continuitySummary}

[BATCH PLAN ĐÃ PHÊ DUYỆT - VIẾT BÁM SÁT KẾ HOẠCH NÀY]
${JSON.stringify(plan.chapters, null, 2)}

[DANH SÁCH NHÂN VẬT ĐƯỢC PHÉP XUẤT HIỆN]
${activeCharacters.map(c => `- ${c.name} (${c.role || 'Nhân vật'}): ${c.personality || ''}. Ngoại hình: ${c.appearance || ''}`).join('\n')}

[DANH SÁCH CẤM KỴ TUYỆT ĐỐI (FORBIDDEN / GATED)]
- NHÂN VẬT BỊ KHÓA (CẤM XUẤT HIỆN, CẤM NHẮC TỚI NHƯ THỂ ĐÃ BIẾT): ${lockedCharacters.map(l => l.characterName).join(', ') || 'Không có'}
- BÍ MẬT & SPOILER CẤM LỘ: ${forbiddenSpoilers.map(s => s.description).concat(currentArc.forbiddenSpoilers || []).join('; ') || 'Không có'}

[QUY TẮC THẾ GIỚI ĐÃ CÔNG BỐ]
${activeFacts.length > 0 ? activeFacts.join('\n') : 'Thế giới tuân theo quy luật tự nhiên và logic bối cảnh.'}

[THƯƠNG TÍCH & CONTINUITY BẮT BUỘC]
${activeInjuries.length > 0 ? activeInjuries.join('\n') : 'Nhân vật ở thể trạng bình thường.'}

[MANH MỐI ĐÃ PHÁT HIỆN]
${knownClues.length > 0 ? knownClues.join('\n') : 'Chưa có manh mối đặc biệt.'}

[KÝ ỨC CÁC CHƯƠNG LIÊN QUAN]
${formatMemoriesForContext(relevantMems)}

[ĐIỂM NỐI VĂN BẢN CHƯƠNG TRƯỚC]
${lastChapterText}
`;
}

/**
 * 3. VALIDATOR CONTEXT PROJECTION (SUPERVISORY):
 * Toàn quyền đối chiếu giữa StoryControl, BatchPlan và văn bản để phát hiện rò rỉ hoặc vi phạm logic.
 */
export function buildValidatorContext(
  control: StoryControl,
  plan: BatchPlan,
  state: StoryState,
  startChapter: number
): string {
  const currentArc = getCurrentArc(control, startChapter);
  const gatedCharNames = (control.characterGates || [])
    .filter(g => g.unlockAtChapter > startChapter)
    .map(g => g.characterName);

  const forbiddenSpoilers = (control.spoilerGates || [])
    .filter(s => s.forbiddenBeforeChapter > startChapter)
    .map(s => s.description)
    .concat(currentArc.forbiddenSpoilers || []);

  const activeInjuries = Object.values(state.characterStates || {}).flatMap(cs =>
    (cs.injuries || [])
      .filter(inj => inj.expectedRecoveryChapter > startChapter)
      .map(inj => `${cs.name} (${inj.type} ở ${inj.bodyPart}, hạn chế: ${inj.restrictions?.join(', ')})`)
  );

  return `=== STORY ENGINE V3: VALIDATOR AUDIT CRITERIA ===
Giai đoạn: ${currentArc.title} (Chương ${startChapter})
Nhân vật đang bị Gate: ${gatedCharNames.join(', ') || 'Không có'}
Bí mật/Spoiler cấm kỵ: ${forbiddenSpoilers.join('; ') || 'Không có'}
Thương tích bắt buộc phải phản ánh: ${activeInjuries.join('; ') || 'Không có'}
Quy tắc Pacing: ${control.pacingRules.minWordsPerChapter} - ${control.pacingRules.maxWordsPerChapter} từ/chương
`;
}
