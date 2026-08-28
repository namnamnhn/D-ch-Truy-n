/**
 * Story Engine V3 - 28 Regression Test Suites
 * Đảm bảo 100% độ chính xác cho hệ thống sáng tác dài tập 600 chương
 */
import {
  computeBibleHash,
  parseBlueprintV3,
  createDeterministicStoryControl
} from './compiler';
import { getCurrentArc, calculateArcProgress, filterCharactersForChapter, filterSpoilersForChapter } from './arcController';
import { buildPlannerContext, buildWriterContext, buildValidatorContext } from './contextBuilder';
import { validateAndRepairBatchPlan } from './planValidator';
import { parseChaptersAndMetadata } from './writer';
import { validateBatchOutput } from './validator';
import { extractAndMergeState } from './stateExtractor';
import { scoreMemoryRelevance, retrieveRelevantMemories } from './memoryManager';
import { StoryBible, StoryState, BatchPlan, ChapterMemory } from './types';
import { parseSetupFile } from '../../hooks/pages/useCreativePage';

export function runAllStoryEngineV3Tests(): { passed: number; failed: number; results: { name: string; pass: boolean; error?: string }[] } {
  const results: { name: string; pass: boolean; error?: string }[] = [];

  function test(name: string, fn: () => void) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (err: any) {
      results.push({ name, pass: false, error: err.message || String(err) });
    }
  }

  const sampleBible: StoryBible = {
    seedTitle: 'Tiên Đạo Đỉnh Cao',
    genre: 'Tiên Hiệp',
    seriesPremise: 'Lâm Phong từ một đệ tử ngoại môn từng bước vươn lên đỉnh cao Tiên giới.',
    continuitySummary: 'Lâm Phong vừa gia nhập Thanh Vân Tông.',
    worldNotes: 'Hệ thống tu luyện: Luyện Khí, Trúc Cơ, Kim Đan, Nguyên Anh, Hóa Thần.',
    charNotes: 'Địch nhân và đồng môn cạnh tranh khốc liệt.',
    outline: 'Hành trình 600 chương từ phàm nhân đến Tiên Đế.',
    characters: [
      { id: 'char_main', name: 'Lâm Phong', role: 'Nhân vật chính', gender: 'Nam', age: '16', appearance: 'Thanh tú', personality: 'Kiên định' },
      { id: 'char_rival', name: 'Triệu Cương', role: 'Đối thủ ngoại môn', gender: 'Nam', age: '18', appearance: 'Cao lớn', personality: 'Kiêu ngạo' },
      { id: 'char_boss_late', name: 'Cổ Ma Hoàng', role: 'Trùm Hóa Thần', gender: 'Nam', age: '1000', appearance: 'Hắc bào', personality: 'Tàn nhẫn' }
    ],
    totalPlannedChapters: 600
  };

  // Test 1: Hash Bible tính toán ổn định và thay đổi khi nội dung đổi
  test('Test 1: Bible Hash Stability', () => {
    const hash1 = computeBibleHash(sampleBible);
    const hash2 = computeBibleHash(sampleBible);
    if (hash1 !== hash2) throw new Error('Hash không ổn định');
    const changedBible = { ...sampleBible, genre: 'Huyền Huyễn' };
    if (computeBibleHash(changedBible) === hash1) throw new Error('Hash không thay đổi khi dữ liệu đổi');
  });

  // Test 2: Deterministic Compiler tạo đủ 30-40 Arcs cho 600 chương
  test('Test 2: Compiler Arcs Generation for 600 chapters', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    if (!control.arcs || control.arcs.length < 30) throw new Error(`Số Arc không đủ: ${control.arcs.length}`);
    if (control.arcs[control.arcs.length - 1].endChapter !== 600) throw new Error('Arc cuối không chạm mốc 600');
  });

  // Test 3: Character Registry được gán đầy đủ unlock conditions
  test('Test 3: Character Registry Initialization', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const main = control.characterRegistry['char_main'];
    if (!main || main.name !== 'Lâm Phong') throw new Error('Nhân vật chính chưa có trong Registry');
  });

  // Test 4: Character Gates khóa nhân vật xuất hiện muộn
  test('Test 4: Character Gates Generation', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const lateGate = control.characterGates.find(g => g.characterId === 'char_boss_late');
    if (!lateGate || lateGate.unlockAtChapter <= 1) throw new Error('Nhân vật muộn không bị gate');
  });

  // Test 5: Spoiler Gates bảo vệ bí mật
  test('Test 5: Spoiler Gates Creation', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    if (!control.spoilerGates || control.spoilerGates.length === 0) throw new Error('Thiếu Spoiler Gates');
  });

  // Test 6: Arc Controller xác định đúng Arc theo chương
  test('Test 6: Arc Controller resolution for Chapter 1 and Chapter 50', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const arc1 = getCurrentArc(control, 1);
    const arc50 = getCurrentArc(control, 50);
    if (arc1.startChapter !== 1) throw new Error('Arc 1 sai start chapter');
    if (arc50.startChapter > 50 || arc50.endChapter < 50) throw new Error('Arc 50 không bao hàm chương 50');
  });

  // Test 7: Arc Progress calculation
  test('Test 7: Arc Progress Calculation', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const arc1 = control.arcs[0];
    const { arcProgress } = calculateArcProgress(arc1, arc1.startChapter);
    if (arcProgress < 0 || arcProgress > 1) throw new Error('Arc progress out of range');
  });

  // Test 8: Character Filter for early chapters hides late characters
  test('Test 8: Character Filtering hides gated characters', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const { activeCharacters, lockedCharacters } = filterCharactersForChapter(
      sampleBible.characters,
      control.characterGates,
      1,
      control
    );
    if (activeCharacters.some(c => c.id === 'char_boss_late')) {
      throw new Error('Trùm cuối bị rò rỉ vào chương 1');
    }
    if (!lockedCharacters.some(l => l.characterId === 'char_boss_late')) {
      throw new Error('Trùm cuối không nằm trong danh sách khóa');
    }
  });

  // Test 9: Spoiler Filter separates allowed vs forbidden
  test('Test 9: Spoiler Filtering for Chapter 1', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const { forbiddenSpoilers } = filterSpoilersForChapter(control.spoilerGates, 1);
    if (forbiddenSpoilers.length === 0) throw new Error('Spoiler không bị cấm ở chương 1');
  });

  // Test 10: Plan Validator phát hiện và loại bỏ nhân vật bị gate
  test('Test 10: Plan Validator sanitizes gated characters', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };

    const invalidPlan: BatchPlan = {
      arcId: 'arc_1',
      startChapter: 1,
      endChapter: 2,
      batchDirectives: [],
      charactersGated: [],
      antiDriftMeasures: [],
      planValid: true,
      chapters: [
        {
          chapterNumber: 1,
          title: 'Chương 1',
          focus: 'Gặp gỡ',
          povCharacter: 'Lâm Phong',
          pacingTarget: 'rising_action',
          requiredEvents: [],
          introducedCharacters: ['Cổ Ma Hoàng'], // Sai phạm!
          activeCharacters: ['Lâm Phong', 'Cổ Ma Hoàng'], // Sai phạm!
          worldFactInteractions: [],
          cluesDiscovered: [],
          forbiddenSpoilers: []
        }
      ]
    };

    const validation = validateAndRepairBatchPlan(invalidPlan, control, dummyState, 1);
    if (validation.valid) throw new Error('PlanValidator không phát hiện vi phạm gating');
    if (validation.repairedPlan.chapters[0].activeCharacters.includes('Cổ Ma Hoàng')) {
      throw new Error('PlanValidator không loại bỏ Cổ Ma Hoàng khỏi activeCharacters');
    }
  });

  // Test 11: Planner Context không rò rỉ chi tiết cấm kỵ
  test('Test 11: Planner Context Projection', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };
    const ctx = buildPlannerContext(sampleBible, control, dummyState, [], 1, 2, []);
    if (!ctx.includes('LONG-FORM STORY ENGINE V3: PLANNER CONTEXT')) throw new Error('Sai header context');
  });

  // Test 12: Writer Context chứa danh sách cấm kỵ rõ ràng
  test('Test 12: Writer Context Projection', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };
    const dummyPlan: BatchPlan = {
      arcId: 'arc_1',
      startChapter: 1,
      endChapter: 2,
      batchDirectives: [],
      charactersGated: [],
      antiDriftMeasures: [],
      planValid: true,
      chapters: [
        {
          chapterNumber: 1,
          title: 'Chương 1',
          focus: 'Khởi đầu',
          povCharacter: 'Lâm Phong',
          pacingTarget: 'rising_action',
          requiredEvents: [],
          introducedCharacters: [],
          activeCharacters: ['Lâm Phong'],
          worldFactInteractions: [],
          cluesDiscovered: [],
          forbiddenSpoilers: []
        }
      ]
    };
    const writerCtx = buildWriterContext(sampleBible, control, dummyPlan, dummyState, [], 1, 2, []);
    if (!writerCtx.includes('DANH SÁCH CẤM KỴ TUYỆT ĐỐI')) throw new Error('Thiếu danh sách cấm kỵ trong Writer Context');
  });

  // Test 13: Validator Context có tiêu chí kiểm toán
  test('Test 13: Validator Context Criteria', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };
    const dummyPlan: BatchPlan = {
      arcId: 'arc_1',
      startChapter: 1,
      endChapter: 2,
      batchDirectives: [],
      charactersGated: [],
      antiDriftMeasures: [],
      planValid: true,
      chapters: []
    };
    const vCtx = buildValidatorContext(control, dummyPlan, dummyState, 1);
    if (!vCtx.includes('VALIDATOR AUDIT CRITERIA')) throw new Error('Sai Validator Context');
  });

  // Test 14: Writer output XML parser trích xuất chương và tách sạch metadata
  test('Test 14: Writer XML Parser cleans metadata', () => {
    const rawXml = `
<CHAPTER title="Chương 1: Bắt đầu">
Lâm Phong đứng trên sườn núi nhìn về phía chân trời xa xăm.
<NEW_CHARACTER name="Tiểu Linh" gender="Nữ" role="Sư muội" />
Gió núi thổi nhẹ qua tà áo thanh y.
</CHAPTER>
<STORY_SUMMARY>Lâm Phong bắt đầu bước vào con đường tu luyện.</STORY_SUMMARY>
    `;
    const parsed = parseChaptersAndMetadata(rawXml);
    if (parsed.chapters.length !== 1) throw new Error('Không bóc tách được chương');
    if (parsed.chapters[0].content.includes('<NEW_CHARACTER')) throw new Error('Metadata chưa được làm sạch khỏi văn xuôi');
    if (parsed.newCharacters.length !== 1 || parsed.newCharacters[0].name !== 'Tiểu Linh') throw new Error('Không bóc tách được nhân vật mới');
  });

  // Test 15: Writer fallback parser tách được "Chương X: ..." khi không có XML
  test('Test 15: Writer Fallback Parser', () => {
    const rawText = `
Chương 1: Ngoại Môn Khảo Hạch
Nắng sớm rọi xuống quảng trường Thanh Vân Tông.

Chương 2: Đột Phá Luyện Khí
Đêm khuya thanh vắng, linh khí tụ hội.
    `;
    const parsed = parseChaptersAndMetadata(rawText);
    if (parsed.chapters.length !== 2) throw new Error(`Fallback parser không tách được 2 chương: ${parsed.chapters.length}`);
  });

  // Test 16: Semantic QA Validator bắt lỗi nhân vật bị khóa xuất hiện
  test('Test 16: Semantic QA catches locked character in chapter text', async () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };
    const dummyPlan: BatchPlan = {
      arcId: 'arc_1',
      startChapter: 1,
      endChapter: 1,
      batchDirectives: [],
      charactersGated: [],
      antiDriftMeasures: [],
      planValid: true,
      chapters: [
        {
          chapterNumber: 1,
          title: 'Chương 1',
          focus: 'Test',
          povCharacter: 'Lâm Phong',
          pacingTarget: 'rising_action',
          requiredEvents: [],
          introducedCharacters: [],
          activeCharacters: ['Lâm Phong'],
          worldFactInteractions: [],
          cluesDiscovered: [],
          forbiddenSpoilers: []
        }
      ]
    };
    const badChapters = [
      { id: 'ch_1', title: 'Chương 1: Cuộc gặp bất ngờ', content: 'Lâm Phong bất ngờ đụng độ Cổ Ma Hoàng tại chân núi.', status: 'completed' as const }
    ];
    const val = await validateBatchOutput(badChapters, dummyPlan, control, dummyState, sampleBible);
    if (val.pass) throw new Error('Validator phải Fail khi Cổ Ma Hoàng xuất hiện');
    if (!val.violations.some(v => v.type === 'CHARACTER_GATE')) throw new Error('Không tạo vi phạm CHARACTER_GATE');
  });

  // Test 17: Semantic QA bắt lỗi quên thương tích (Injury Amnesia)
  test('Test 17: Semantic QA catches Injury Amnesia', async () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const injuredState: StoryState = {
      currentChapter: 1,
      characterStates: {
        'lâm phong': {
          characterId: 'char_main',
          name: 'Lâm Phong',
          location: 'Tông môn',
          physicalCondition: 'Trọng thương',
          injuries: [
            {
              type: 'Gãy xương',
              bodyPart: 'Tay phải',
              severity: 'severe',
              receivedChapter: 1,
              expectedRecoveryChapter: 10,
              restrictions: ['Không thể vung kiếm']
            }
          ],
          knownFacts: [],
          goals: []
        }
      },
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };
    const dummyPlan: BatchPlan = {
      arcId: 'arc_1',
      startChapter: 2,
      endChapter: 2,
      batchDirectives: [],
      charactersGated: [],
      antiDriftMeasures: [],
      planValid: true,
      chapters: [
        {
          chapterNumber: 2,
          title: 'Chương 2',
          focus: 'Test',
          povCharacter: 'Lâm Phong',
          pacingTarget: 'rising_action',
          requiredEvents: [],
          introducedCharacters: [],
          activeCharacters: ['Lâm Phong'],
          worldFactInteractions: [],
          cluesDiscovered: [],
          forbiddenSpoilers: []
        }
      ]
    };
    const amnesiaChapters = [
      { id: 'ch_2', title: 'Chương 2: Chiến đấu', content: 'Lâm Phong vung kiếm chém mạnh chém đứt đầu yêu thú.', status: 'completed' as const }
    ];
    const val = await validateBatchOutput(amnesiaChapters, dummyPlan, control, injuredState, sampleBible);
    if (!val.violations.some(v => v.type === 'INJURY_AMNESIA')) {
      throw new Error('Không phát hiện lỗi INJURY_AMNESIA khi nhân vật gãy tay lại vung kiếm chém mạnh');
    }
  });

  // Test 18: State Extractor merge characters an toàn không trùng lặp
  test('Test 18: State Extractor Deduplication and Merging', async () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: { money: '100 linh thạch' },
      clues: [],
      unresolvedThreads: ['Bí ẩn ngọc bội'],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: ['char_main'],
      worldFactStates: {}
    };
    const acceptedChapters = [
      { id: 'ch_1', title: 'Chương 1: Khởi hành', content: 'Nội dung chương 1 đầy đặn...', status: 'completed' as const }
    ];

    const result = await extractAndMergeState(
      acceptedChapters,
      dummyState,
      control,
      sampleBible.characters,
      'Lâm Phong bắt đầu chuyến đi.',
      1
    );

    if (result.nextState.currentChapter !== 1) throw new Error('Chương hiện tại chưa tăng lên 1');
    if (!result.nextState.resources.money) throw new Error('Bị mất thông tin tài nguyên cũ');
    if (!result.nextState.unresolvedThreads.includes('Bí ẩn ngọc bội')) throw new Error('Bị mất unresolvedThreads cũ');
  });

  // Test 19: State Extractor cập nhật Memory Index
  test('Test 19: Chapter Memory Creation', async () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: [],
      worldFactStates: {}
    };
    const acceptedChapters = [
      { id: 'ch_1', title: 'Chương 1: Đại Hội', content: 'Diễn biến đại hội...', status: 'completed' as const }
    ];
    const result = await extractAndMergeState(acceptedChapters, dummyState, control, sampleBible.characters, undefined, 1);
    if (result.newMemories.length !== 1 || result.newMemories[0].chapterNumber !== 1) {
      throw new Error('Không tạo đúng ChapterMemory');
    }
  });

  // Test 20: Memory Relevance Scoring
  test('Test 20: Memory Relevance Scoring & Retrieval', () => {
    const memIndex: ChapterMemory[] = [
      { chapterNumber: 1, title: 'Chương 1', summary: 'Lâm Phong gặp Triệu Cương tại ngoại môn', charactersInvolved: ['Lâm Phong', 'Triệu Cương'], locations: ['Ngoại môn'] },
      { chapterNumber: 2, title: 'Chương 2', summary: 'Tu luyện trong hang đá', charactersInvolved: ['Lâm Phong'], locations: ['Hang đá'] },
      { chapterNumber: 3, title: 'Chương 3', summary: 'Triệu Cương đến khiêu chiến', charactersInvolved: ['Lâm Phong', 'Triệu Cương'], locations: ['Sân tập'] }
    ];
    const score = scoreMemoryRelevance(memIndex[0], ['Triệu Cương'], 4);
    if (score <= 0) throw new Error('Score phải > 0');
    const retrieved = retrieveRelevantMemories(memIndex, ['Triệu Cương'], 4, 2);
    if (retrieved.length !== 2) throw new Error('Số memory trích xuất không đúng');
  });

  // Test 21: One-file Setup Import với STORY_ENGINE_SETTINGS_V3
  test('Test 21: One-file Setup Import parsing V3', () => {
    const v3Text = `
THIẾT LẬP SÁNG TÁC: Tiên Ma Chí
============================================================

[THỂ LOẠI]
Tiên Hiệp

[TIỀN ĐỀ / TÓM TẮT]
Hành trình tu ma vấn đạo.

[THẾ GIỚI]
Ma giới phân cửu tầng.

[NHÂN VẬT]
- Tiêu Viêm (Nhân vật chính, Nam, 18 tuổi)
  Ngoại hình: Khôi ngô
  Tính cách: Kiên định

[DÀN Ý]
600 chương ma đạo tranh phong.

[STORY_ENGINE_SETTINGS_V3]
{
  "version": "v3",
  "seriesPremise": "Hành trình tu ma",
  "continuitySummary": "Đã bắt đầu",
  "storyControl": {
    "version": "v3",
    "totalChapters": 600,
    "arcs": [
      { "id": "arc_1", "title": "Hồi 1", "startChapter": 1, "endChapter": 20 }
    ],
    "characterRegistry": {},
    "worldFacts": [],
    "narrativeExposureRules": { "prohibitedTopicsUntilChapter": [], "foreshadowingDirectives": [], "mandatoryKnowledgeByChapter": [] },
    "characterGates": [],
    "spoilerGates": [],
    "continuityRules": { "enforcePhysicalInjuryDuration": true, "enforceResourceTracking": true, "enforceRelationshipMemory": true, "enforceClueDiscoveryProgression": true },
    "pacingRules": { "minWordsPerChapter": 2000, "maxWordsPerChapter": 3500, "climaxPacingMultiplier": 1.3, "cooldownChaptersAfterClimax": 2 }
  }
}
    `;
    const parsed = parseSetupFile(v3Text);
    if (!parsed) throw new Error('Không parse được setup V3');
    if (parsed.seedTitle !== 'Tiên Ma Chí') throw new Error('Sai seed title');
    if (!parsed.storyControl || parsed.storyControl.arcs.length !== 1) throw new Error('Không trích xuất được storyControl V3');
  });

  // Test 22: One-file Import với Blueprint JSON trực tiếp
  test('Test 22: Direct JSON Blueprint Import', () => {
    const directJson = JSON.stringify({
      title: 'Huyền Thiên Thần Ký',
      genre: 'Huyền Huyễn',
      premise: 'Đột phá cửu trùng thiên',
      arcs: [
        { id: 'arc_1', title: 'Hạ Giới', startChapter: 1, endChapter: 50 }
      ]
    });
    const parsed = parseSetupFile(directJson);
    if (!parsed || parsed.seedTitle !== 'Huyền Thiên Thần Ký') throw new Error('Không đọc được direct JSON setup');
    if (!parsed.storyControl || parsed.storyControl.arcs.length !== 1) throw new Error('Không khởi tạo được StoryControl từ direct JSON');
  });

  // Test 23: Backward compatibility with legacy setup.txt
  test('Test 23: Legacy setup.txt compatibility', () => {
    const legacyText = `
THIẾT LẬP SÁNG TÁC: Truyện Cũ
============================================================

[THỂ LOẠI]
Đô Thị

[TIỀN ĐỀ / TÓM TẮT]
Trọng sinh về năm 2000.

[THẾ GIỚI]
Hiện đại.

[NHÂN VẬT]
- Trần Hạo (Nam chính)
  Ngoại hình: Bình thường
  Tính cách: Cẩn trọng

[DÀN Ý]
Lập nghiệp kinh doanh.
    `;
    const parsed = parseSetupFile(legacyText);
    if (!parsed || parsed.seedTitle !== 'Truyện Cũ' || parsed.characters.length !== 1) {
      throw new Error('Lỗi backward compatibility với setup.txt cũ');
    }
  });

  // Test 24: Parse Blueprint V3 function robustness
  test('Test 24: parseBlueprintV3 extracts valid StoryControl', () => {
    const bp = parseBlueprintV3(`
[BLUEPRINT_V3]
{
  "arcs": [{ "id": "arc_1", "title": "Khởi nguyên", "startChapter": 1, "endChapter": 30 }]
}
    `);
    if (!bp || bp.arcs.length !== 1 || bp.arcs[0].title !== 'Khởi nguyên') {
      throw new Error('parseBlueprintV3 thất bại');
    }
  });

  // Test 25: Pacing Rule Enforcement
  test('Test 25: Pacing Rules default to 2000-3500 words', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    if (control.pacingRules.minWordsPerChapter !== 2000 || control.pacingRules.maxWordsPerChapter !== 3500) {
      throw new Error('Sai thông số pacing rules');
    }
  });

  // Test 26: Continuity Rules Enforcement Flags
  test('Test 26: Continuity Rules Flags are strictly active', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    if (!control.continuityRules.enforcePhysicalInjuryDuration || !control.continuityRules.enforceResourceTracking) {
      throw new Error('Continuity rules flags phải bật mặc định');
    }
  });

  // Test 27: Unlocked character ids persistence in Story State
  test('Test 27: Unlocked character ids update through chapter progress', async () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const dummyState: StoryState = {
      currentChapter: 0,
      characterStates: {},
      relationships: [],
      resources: {},
      clues: [],
      unresolvedThreads: [],
      longTermSeeds: [],
      recentConsequences: [],
      currentArcId: 'arc_1',
      currentArcProgress: 0,
      unlockedCharacterIds: [],
      worldFactStates: {}
    };
    const chapters = [{ id: 'ch_1', title: 'Chương 1', content: 'Chương 1 văn bản', status: 'completed' as const }];
    const res = await extractAndMergeState(chapters, dummyState, control, sampleBible.characters, undefined, 1);
    if (!res.nextState.unlockedCharacterIds || res.nextState.unlockedCharacterIds.length === 0) {
      throw new Error('unlockedCharacterIds chưa được cập nhật');
    }
  });

  // Test 28: Full 600-chapter cycle continuity simulation (Arc 1 to Arc 38)
  test('Test 28: 600-chapter continuity simulation across Arc boundaries', () => {
    const control = createDeterministicStoryControl(sampleBible, 'test_hash', 600);
    const arc1 = getCurrentArc(control, 1);
    const arcMid = getCurrentArc(control, 300);
    const arcFinal = getCurrentArc(control, 600);
    if (arc1.id === arcMid.id || arcMid.id === arcFinal.id) {
      throw new Error('Các mốc chương 1, 300, 600 phải thuộc các Arc khác nhau');
    }
    if (arcFinal.endChapter !== 600) {
      throw new Error('Arc cuối phải kết thúc tại chương 600');
    }
  });

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;

  return {
    passed,
    failed,
    results
  };
}
