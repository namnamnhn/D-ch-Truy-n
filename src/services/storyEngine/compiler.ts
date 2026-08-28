import { Character } from '../../types';
import { StoryBible, StoryControl, StoryState, ArcDefinition, CharacterGate, SpoilerGate, CharacterRegistryEntry, WorldFact, NarrativeExposureRules, STORY_CONTROL_SCHEMA_VERSION, STORY_STATE_SCHEMA_VERSION } from './types';
import { getCurrentArc, calculateArcProgress } from './arcController';
import { createStoryControlFromBlueprint, parseBlueprintContent, validateBlueprintV3Object } from './blueprintParser';
import { isRecord } from './runtimeValidation';
import { getCharacterAccess, isWorldFactAvailable } from './storyAccess';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Tính hash xác thực để kiểm tra xem Bible có thay đổi không
 */
export function computeBibleHash(bible: StoryBible): string {
  const source = stableStringify({
    storyControlSchemaVersion: STORY_CONTROL_SCHEMA_VERSION,
    seedTitle: bible.seedTitle,
    genre: bible.genre,
    seriesPremise: bible.seriesPremise,
    // continuitySummary is derived runtime state and must not invalidate its own authoritative source hash.
    worldNotes: bible.worldNotes,
    charNotes: bible.charNotes,
    outline: bible.outline,
    characters: (bible.characters || []).map(character => ({
      id: character.id,
      name: character.name,
      gender: character.gender,
      age: character.age,
      role: character.role,
      appearance: character.appearance,
      personality: character.personality
    })),
    totalPlannedChapters: bible.totalPlannedChapters || 600,
    storyEngineSettingsV3: bible.storyEngineSettingsV3,
    blueprintV3: bible.blueprintV3
  });
  let hash = 0;
  for (let i = 0; i < source.length; i++) {
    const char = source.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash |= 0;
  }
  return `v3_hash_${Math.abs(hash).toString(16)}`;
}

/**
 * Trích xuất và chuẩn hóa Blueprint V3 nếu được cung cấp trực tiếp
 */
export function parseBlueprintV3(rawContent: string): StoryControl | null {
  return parseBlueprintContent(rawContent);
}

/**
 * Đảm bảo các trường mặc định cho StoryControl V3
 */
function ensureStoryControlV3Defaults(parsed: unknown): StoryControl {
  return createStoryControlFromBlueprint(validateBlueprintV3Object(parsed));
}

/**
 * Story Control Compiler V3:
 * Phân tích Bible (hoặc Blueprint) để tạo ra StoryControl V3 bất biến cho 600 chương
 */
export async function compileStoryControl(
  bible: StoryBible,
  runner?: (prompt: string) => Promise<string>
): Promise<StoryControl> {
  const hash = computeBibleHash(bible);
  const totalChapters = bible.totalPlannedChapters || 600;

  // Blueprint imported from the dedicated V3 block is authoritative.
  if (bible.blueprintV3) {
    return createStoryControlFromBlueprint(bible.blueprintV3, hash, bible.storyEngineSettingsV3);
  }

  // 1. Kiểm tra xem có Blueprint V3 sẵn trong outline / notes không
  const customBlueprint = parseBlueprintV3(bible.outline) || parseBlueprintV3(bible.worldNotes);
  if (customBlueprint) {
    customBlueprint.sourceHash = hash;
    return customBlueprint;
  }

  // 2. Nếu có AI Runner, yêu cầu AI phân bổ Arc và Gating theo cấu trúc chuyên sâu
  if (runner) {
    const prompt = `Bạn là Story Architecture Compiler V3. 
Dựa vào Story Bible sau, hãy thiết kế toàn bộ bản thiết kế kiến trúc dài hạn (STORY CONTROL V3) cho tác phẩm dài ${totalChapters} chương.

THÔNG TIN BIBLE:
- Tựa truyện: ${bible.seedTitle}
- Thể loại: ${bible.genre}
- Tiền đề cốt truyện: ${bible.seriesPremise}
- Thế giới / Hệ thống: ${bible.worldNotes}
- Dàn ý ban đầu: ${bible.outline}
- Nhân vật đã khai báo: ${(bible.characters || []).map(c => `${c.name} (${c.role || 'Chưa rõ vai trò'})`).join(', ')}

HÃY TRẢ VỀ DUY NHẤT 1 JSON VỚI ĐỊNH DẠNG SAU (Không thêm text markdown ngoài JSON):
{
  "totalChapters": ${totalChapters},
  "arcs": [
    {
      "id": "arc_1",
      "title": "Tên hồi 1",
      "startChapter": 1,
      "endChapter": 20,
      "theme": "Chủ đề chính",
      "coreConflict": "Mâu thuẫn cốt lõi",
      "climaxChapter": 18,
      "pacing": "slow_burn" | "accelerating" | "high_stakes" | "climax" | "resolution",
      "unlockedCharacterIds": ["char_1", "char_2"],
      "keyMilestones": ["Cột mốc 1", "Cột mốc 2"],
      "worldBuildingFocus": "Trọng tâm thế giới",
      "forbiddenSpoilers": ["Không tiết lộ thân phận thật của X"]
    }
  ],
  "characterRegistry": {
    "char_1": {
      "id": "char_1",
      "name": "Tên nhân vật",
      "aliasSet": ["Tên", "Biệt danh"],
      "role": "Nhân vật chính",
      "gender": "Nam",
      "age": "18",
      "initialFaction": "Gia tộc",
      "appearance": "Mô tả ngoại hình",
      "personality": "Tính cách",
      "coreMotivation": "Động lực cốt lõi",
      "forbiddenSpoilers": ["Bí mật lớn nhất của nhân vật"],
      "unlockCondition": { "type": "arc", "value": "arc_1" },
      "allowedArcs": ["arc_1", "arc_2"]
    }
  },
  "worldFacts": [
    {
      "id": "fact_1",
      "category": "magic_system",
      "fact": "Quy tắc vận hành sức mạnh",
      "scope": "public",
      "introducedAtChapter": 1,
      "secretTruth": "Sự thật bị che giấu về quy tắc này"
    }
  ],
  "narrativeExposureRules": {
    "prohibitedTopicsUntilChapter": [
      { "topic": "Bí mật thân thế", "unlockChapter": 100 }
    ],
    "foreshadowingDirectives": [
      { "hint": "Gợi ý về chiếc ngọc bội", "plantArcId": "arc_1", "payoffArcId": "arc_5" }
    ],
    "mandatoryKnowledgeByChapter": []
  },
  "characterGates": [
    {
      "characterId": "char_2",
      "characterName": "Tên nhân vật",
      "unlockAtArcId": "arc_2",
      "unlockAtChapter": 21,
      "prerequisiteClues": ["Manh mối cần có"],
      "reason": "Chưa đến thời điểm xuất hiện"
    }
  ],
  "spoilerGates": [
    {
      "id": "spoiler_1",
      "description": "Thân phận trùm cuối",
      "forbiddenBeforeChapter": 150,
      "permittedArcs": ["arc_10"],
      "relatedCharacters": ["char_boss"]
    }
  ]
}`;

    try {
      const rawRes = await runner(prompt);
      const cleaned = rawRes.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed: unknown = JSON.parse(cleaned);
      const control = ensureStoryControlV3Defaults(parsed);
      control.sourceHash = hash;
      return control;
    } catch (e) {
      console.warn('[StoryEngineCompiler] AI generation failed, falling back to deterministic compiler:', e);
    }
  }

  // 3. DETERMINISTIC COMPILER FALLBACK (Tạo 30-40 Arcs vững chắc và logic)
  return createDeterministicStoryControl(bible, hash, totalChapters);
}

/**
 * Xây dựng StoryControl V3 logic và chi tiết bằng thuật toán Deterministic
 */
export function createDeterministicStoryControl(bible: StoryBible, sourceHash: string, totalChapters: number): StoryControl {
  const characters = bible.characters || [];
  const arcLength = 15; // Mỗi Arc kéo dài khoảng 15 chương
  const totalArcsCount = Math.max(1, Math.ceil(totalChapters / arcLength));

  const arcs: ArcDefinition[] = [];
  const characterGates: CharacterGate[] = [];
  const spoilerGates: SpoilerGate[] = [];
  const characterRegistry: Record<string, CharacterRegistryEntry> = {};

  // Khởi tạo characterRegistry
  characters.forEach((c, idx) => {
    const charId = c.id || `char_${idx + 1}`;
    const unlockArcIndex = idx === 0 ? 0 : Math.min(Math.floor(idx / 2), totalArcsCount - 1);
    const unlockChapter = unlockArcIndex * arcLength + 1;
    const unlockArcId = `arc_${unlockArcIndex + 1}`;

    characterRegistry[charId] = {
      id: charId,
      name: c.name,
      aliasSet: [c.name],
      role: c.role || (idx === 0 ? 'Nhân vật chính' : 'Nhân vật phụ'),
      gender: c.gender || 'Chưa rõ',
      age: c.age || 'Chưa rõ',
      initialFaction: 'Thế lực sơ khởi',
      appearance: c.appearance || '',
      personality: c.personality || '',
      coreMotivation: idx === 0 ? 'Vươn lên đỉnh cao và khám phá thế giới' : 'Đồng hành hoặc thử thách nhân vật chính',
      forbiddenSpoilers: [`Bí mật tương lai về ${c.name}`],
      restrictions: [],
      unlockCondition: { type: 'arc', value: unlockArcId },
      allowedArcs: Array.from({ length: totalArcsCount - unlockArcIndex }, (_, i) => `arc_${unlockArcIndex + 1 + i}`)
    };

    if (idx > 0 && unlockArcIndex > 0) {
      characterGates.push({
        characterId: charId,
        characterName: c.name,
        unlockAtArcId: unlockArcId,
        unlockAtChapter: unlockChapter,
        prerequisiteClues: [`Manh mối liên quan đến ${c.name}`],
        reason: `Nhân vật ${c.name} chỉ xuất hiện từ Hồi ${unlockArcIndex + 1} (Chương ${unlockChapter}).`
      });
    }
  });

  // Tạo các Arcs phân chia hợp lý từ 1 đến 600 chương
  const arcThemes = [
    { title: 'Khởi Đầu & Thức Tỉnh', theme: 'Bắt đầu cuộc hành trình và phát hiện tiềm năng bản thân', conflict: 'Thích nghi hoàn cảnh và vượt qua áp chế sơ khởi' },
    { title: 'Thử Thách Sơ Cấp', theme: 'Khẳng định thực lực trong phạm vi ban đầu', conflict: 'Cạnh tranh nội bộ thế lực' },
    { title: 'Dấu Vết & Khám Phá', theme: 'Khám phá địa điểm, bằng chứng và cơ hội mới', conflict: 'Các lợi ích đối lập cùng tranh giành một mục tiêu' },
    { title: 'Xung Đột Mở Rộng', theme: 'Bối cảnh mở rộng ra ngoài khu vực quen thuộc', conflict: 'Mâu thuẫn giữa các nhóm và lợi ích lớn' },
    { title: 'Đột Phá & Biến Cố', theme: 'Bước ngoặt lớn thay đổi cục diện cuộc đời', conflict: 'Bị truy đuổi hoặc đối mặt với thảm họa bất ngờ' },
    { title: 'Tích Lũy Năng Lực', theme: 'Rèn luyện, chuẩn bị và xây dựng mạng lưới hỗ trợ', conflict: 'Tập hợp đồng minh và tạo nền tảng hành động' },
    { title: 'Phản Kích & Khẳng Định', theme: 'Trở lại quét sạch kẻ thù cũ, lập lại trật tự', conflict: 'Đại chiến thanh trừng ân oán' },
    { title: 'Bí Mật Nền Tảng', theme: 'Tiếp cận sự thật về bối cảnh và lịch sử quan trọng', conflict: 'Chống lại những lực lượng ngầm thao túng tình thế' },
    { title: 'Khủng Hoảng Lan Rộng', theme: 'Hiểm họa vượt khỏi phạm vi xung đột ban đầu', conflict: 'Tập hợp đồng minh để ngăn hậu quả không thể đảo ngược' },
    { title: 'Quyết Định Cuối', theme: 'Cuộc đối đầu quyết định kết cục của hành trình', conflict: 'Đối diện trực tiếp với lực lượng đối kháng chính' }
  ];

  for (let i = 0; i < totalArcsCount; i++) {
    const arcId = `arc_${i + 1}`;
    const startCh = i * arcLength + 1;
    const endCh = Math.min((i + 1) * arcLength, totalChapters);
    const themeIdx = i % arcThemes.length;
    const currentTheme = arcThemes[themeIdx];
    const cycle = Math.floor(i / arcThemes.length) + 1;
    const cycleSuffix = cycle > 1 ? ` (Giai đoạn ${cycle})` : '';

    const unlockedForThisArc = Object.values(characterRegistry)
      .filter(char => char.allowedArcs.includes(arcId))
      .map(char => char.id);

    arcs.push({
      id: arcId,
      title: `Hồi ${i + 1}: ${currentTheme.title}${cycleSuffix}`,
      startChapter: startCh,
      endChapter: endCh,
      theme: `${currentTheme.theme}${cycleSuffix}`,
      coreConflict: `${currentTheme.conflict}${cycleSuffix}`,
      climaxChapter: Math.max(startCh, endCh - 2),
      pacing: i % 3 === 0 ? 'slow_burn' : (i % 3 === 1 ? 'accelerating' : 'high_stakes'),
      unlockedCharacterIds: unlockedForThisArc,
      keyMilestones: [
        `Khởi phát sự kiện Hồi ${i + 1} tại chương ${startCh}`,
        `Đạt cao trào xung đột tại chương ${Math.max(startCh, endCh - 2)}`,
        `Thu hoạch kết quả và mở ra bước chuyển tiếp tại chương ${endCh}`
      ],
      worldBuildingFocus: `Mở rộng bối cảnh thế giới tương ứng với giai đoạn ${i + 1}`,
      forbiddenSpoilers: [
        `Không tiết lộ sự kiện cao trào của các Hồi tương lai (sau chương ${endCh})`,
        `Không đưa nhân vật bị khóa ở các hồi sau vào trước thời điểm mở khóa`
      ]
    });
  }

  // Tạo Spoiler Gates cho các mốc quan trọng
  spoilerGates.push(
    {
      id: 'spoiler_ultimate_origin',
      description: 'Chân tướng nguồn gốc thế giới và thân phận sâu xa nhất',
      forbiddenBeforeChapter: Math.floor(totalChapters * 0.7),
      permittedArcs: arcs.slice(Math.floor(arcs.length * 0.7)).map(a => a.id),
      relatedCharacters: characters.map(c => c.id || c.name)
    },
    {
      id: 'spoiler_final_antagonist',
      description: 'Thân phận của kẻ đứng sau toàn bộ âm mưu tối thượng',
      forbiddenBeforeChapter: Math.floor(totalChapters * 0.5),
      permittedArcs: arcs.slice(Math.floor(arcs.length * 0.5)).map(a => a.id),
      relatedCharacters: []
    }
  );

  // Khởi tạo World Facts từ Bible
  const worldFacts: WorldFact[] = [
    {
      id: 'fact_world_rules',
      category: 'world_rules',
      fact: bible.worldNotes || `Các quy tắc của bối cảnh ${bible.genre || 'đã chọn'} phải nhất quán với tiền đề.`,
      scope: 'public',
      visibility: 'always',
      introducedAtChapter: 1
    },
    {
      id: 'fact_world_geography',
      category: 'geography',
      fact: 'Địa lý, khoảng cách và các khu vực quan trọng tuân theo mô tả thế giới của tác giả.',
      scope: 'public',
      visibility: 'always',
      introducedAtChapter: 1
    }
  ];

  const narrativeExposureRules: NarrativeExposureRules = {
    prohibitedTopicsUntilChapter: [
      { topic: 'Bí mật về nguồn gốc xung đột trung tâm', unlockChapter: Math.floor(totalChapters * 0.6) },
      { topic: 'Sự thật về biến cố nền tảng trong lịch sử', unlockChapter: Math.floor(totalChapters * 0.75) }
    ],
    foreshadowingDirectives: [
      { hint: 'Gợi ý nhẹ nhàng về một bất thường chưa được giải thích', plantArcId: 'arc_1', payoffArcId: 'arc_3' }
    ],
    mandatoryKnowledgeByChapter: []
  };

  return {
    version: 'v3',
    schemaVersion: STORY_CONTROL_SCHEMA_VERSION,
    sourceHash,
    totalChapters,
    arcs,
    characterRegistry,
    worldFacts,
    narrativeExposureRules,
    characterGates,
    spoilerGates,
    continuityRules: {
      enforcePhysicalInjuryDuration: true,
      enforceResourceTracking: true,
      enforceRelationshipMemory: true,
      enforceClueDiscoveryProgression: true
    },
    pacingRules: {
      minWordsPerChapter: 2000,
      maxWordsPerChapter: 3500,
      climaxPacingMultiplier: 1.3,
      cooldownChaptersAfterClimax: 2
    },
    mysteryThreads: [],
    authorOnlySecrets: []
  };
}

/**
 * Factory chuẩn tạo StoryState V3 ban đầu hoặc fallback
 */
export function createInitialStoryState(
  control: StoryControl,
  currentChapter: number = 0,
  initialCharacters: Character[] = []
): StoryState {
  const currentArc = getCurrentArc(control, Math.max(1, currentChapter || 1));
  const { arcProgress } = calculateArcProgress(currentArc, Math.max(1, currentChapter || 1));

  // Xác định danh sách nhân vật mở khóa theo gates
  const unlockedCharacterIds = new Set<string>();
  Object.values(control.characterRegistry || {}).forEach(character => {
    if (getCharacterAccess(control, character, Math.max(1, currentChapter)).canMention) {
      unlockedCharacterIds.add(character.id);
    }
  });
  initialCharacters.forEach(character => {
    if (!control.characterRegistry?.[character.id]
      && !(control.characterGates || []).some(gate => gate.characterId === character.id && gate.unlockAtChapter > Math.max(1, currentChapter))) {
      unlockedCharacterIds.add(character.id);
    }
  });

  // Trạng thái World Facts ban đầu
  const worldFactStates: Record<string, 'hidden' | 'foreshadowed' | 'revealed'> = {};
  (control.worldFacts || []).forEach(wf => {
    if (isWorldFactAvailable(wf, Math.max(1, currentChapter))) {
      worldFactStates[wf.id] = 'revealed';
    } else {
      worldFactStates[wf.id] = 'hidden';
    }
  });

  return {
    schemaVersion: STORY_STATE_SCHEMA_VERSION,
    sourceHash: control.sourceHash,
    currentChapter,
    characterStates: {},
    relationships: [],
    resources: {},
    clues: [],
    unresolvedThreads: [],
    longTermSeeds: [],
    recentConsequences: [],
    currentArcId: currentArc.id,
    currentArcProgress: arcProgress,
    unlockedCharacterIds: Array.from(unlockedCharacterIds),
    worldFactStates,
    activeFactions: [],
    knowledgeLedger: [],
    timeline: [],
    continuitySummary: '',
    consequences: []
  };
}
