import { Character } from '../../types';
import { StoryBible, StoryControl, StoryState, ArcDefinition, CharacterGate, SpoilerGate, CharacterRegistryEntry, WorldFact, NarrativeExposureRules } from './types';
import { getCurrentArc, calculateArcProgress } from './arcController';

/**
 * Tính hash xác thực để kiểm tra xem Bible có thay đổi không
 */
export function computeBibleHash(bible: StoryBible): string {
  const charNames = (bible.characters || []).map(c => c.name).sort().join(',');
  const source = `${bible.seedTitle}|${bible.genre}|${bible.seriesPremise}|${bible.worldNotes}|${bible.outline}|${charNames}|${bible.totalPlannedChapters || 600}`;
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
  try {
    if (!rawContent || !rawContent.trim()) return null;
    
    // Nếu là file JSON thuần
    if (rawContent.trim().startsWith('{') && rawContent.trim().endsWith('}')) {
      const parsed = JSON.parse(rawContent);
      if (parsed.arcs && parsed.arcs.length > 0) {
        return ensureStoryControlV3Defaults(parsed);
      }
    }

    // Nếu là file có block [STORY_ENGINE_SETTINGS_V3] hoặc [BLUEPRINT_V3]
    const match = rawContent.match(/\[(?:STORY_ENGINE_SETTINGS_V3|BLUEPRINT_V3)\]\s*\n([\s\S]*?)(?=\n\[[A-Z0-9_]+\]|$)/i);
    if (match && match[1]) {
      const jsonStr = match[1].replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed.arcs && parsed.arcs.length > 0) {
        return ensureStoryControlV3Defaults(parsed);
      }
    }
  } catch (err) {
    console.warn('[parseBlueprintV3] Failed to parse custom blueprint JSON:', err);
  }
  return null;
}

/**
 * Đảm bảo các trường mặc định cho StoryControl V3
 */
function ensureStoryControlV3Defaults(parsed: any): StoryControl {
  const arcs: ArcDefinition[] = Array.isArray(parsed.arcs) ? parsed.arcs.map((a: any, idx: number) => ({
    id: a.id || `arc_${idx + 1}`,
    title: a.title || `Hồi ${idx + 1}`,
    startChapter: Number(a.startChapter) || (idx * 15 + 1),
    endChapter: Number(a.endChapter) || ((idx + 1) * 15),
    theme: a.theme || 'Trưởng thành & Khám phá',
    coreConflict: a.coreConflict || 'Đối đầu thử thách',
    climaxChapter: Number(a.climaxChapter) || ((idx + 1) * 15 - 2),
    pacing: a.pacing || 'accelerating',
    unlockedCharacterIds: Array.isArray(a.unlockedCharacterIds) ? a.unlockedCharacterIds : [],
    keyMilestones: Array.isArray(a.keyMilestones) ? a.keyMilestones : [],
    worldBuildingFocus: a.worldBuildingFocus || 'Mở rộng thế giới',
    forbiddenSpoilers: Array.isArray(a.forbiddenSpoilers) ? a.forbiddenSpoilers : []
  })) : [];

  const characterRegistry: Record<string, CharacterRegistryEntry> = {};
  if (parsed.characterRegistry && typeof parsed.characterRegistry === 'object') {
    for (const key of Object.keys(parsed.characterRegistry)) {
      const char = parsed.characterRegistry[key];
      characterRegistry[key] = {
        id: char.id || key,
        name: char.name || key,
        aliasSet: Array.isArray(char.aliasSet) ? char.aliasSet : [char.name || key],
        role: char.role || 'Nhân vật',
        gender: char.gender || 'Chưa rõ',
        age: char.age || 'Chưa rõ',
        initialFaction: char.initialFaction || 'Tự do',
        appearance: char.appearance || '',
        personality: char.personality || '',
        coreMotivation: char.coreMotivation || '',
        forbiddenSpoilers: Array.isArray(char.forbiddenSpoilers) ? char.forbiddenSpoilers : [],
        unlockCondition: char.unlockCondition || { type: 'arc', value: 'arc_1' },
        allowedArcs: Array.isArray(char.allowedArcs) ? char.allowedArcs : arcs.map(a => a.id),
        deathOrExitChapter: char.deathOrExitChapter
      };
    }
  }

  const worldFacts: WorldFact[] = Array.isArray(parsed.worldFacts) ? parsed.worldFacts : [];
  const narrativeExposureRules: NarrativeExposureRules = parsed.narrativeExposureRules || {
    prohibitedTopicsUntilChapter: [],
    foreshadowingDirectives: [],
    mandatoryKnowledgeByChapter: []
  };

  return {
    version: 'v3',
    sourceHash: parsed.sourceHash || `custom_${Date.now()}`,
    totalChapters: Number(parsed.totalChapters) || (arcs.length > 0 ? arcs[arcs.length - 1].endChapter : 600),
    arcs,
    characterRegistry,
    worldFacts,
    narrativeExposureRules,
    characterGates: Array.isArray(parsed.characterGates) ? parsed.characterGates : [],
    spoilerGates: Array.isArray(parsed.spoilerGates) ? parsed.spoilerGates : [],
    continuityRules: {
      enforcePhysicalInjuryDuration: parsed.continuityRules?.enforcePhysicalInjuryDuration ?? true,
      enforceResourceTracking: parsed.continuityRules?.enforceResourceTracking ?? true,
      enforceRelationshipMemory: parsed.continuityRules?.enforceRelationshipMemory ?? true,
      enforceClueDiscoveryProgression: parsed.continuityRules?.enforceClueDiscoveryProgression ?? true,
    },
    pacingRules: {
      minWordsPerChapter: Number(parsed.pacingRules?.minWordsPerChapter) || 2000,
      maxWordsPerChapter: Number(parsed.pacingRules?.maxWordsPerChapter) || 3500,
      climaxPacingMultiplier: Number(parsed.pacingRules?.climaxPacingMultiplier) || 1.3,
      cooldownChaptersAfterClimax: Number(parsed.pacingRules?.cooldownChaptersAfterClimax) || 2
    }
  };
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
      const parsed = JSON.parse(cleaned);
      parsed.sourceHash = hash;
      return ensureStoryControlV3Defaults(parsed);
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
    { title: 'Bí Cảnh & Duyên Ngộ', theme: 'Khám phá di tích cổ xưa, thu thập cơ duyên', conflict: 'Đối đầu các thế lực đối địch săn tìm báu vật' },
    { title: 'Xung Đột Mở Rộng', theme: 'Thế giới mở rộng, bước chân ra ngoài khu vực quen thuộc', conflict: 'Mâu thuẫn giữa các tông môn / phe phái lớn' },
    { title: 'Đột Phá & Biến Cố', theme: 'Bước ngoặt lớn thay đổi cục diện cuộc đời', conflict: 'Bị truy đuổi hoặc đối mặt với thảm họa bất ngờ' },
    { title: 'Tích Lũy Sức Mạnh', theme: 'Ẩn nhẫn tu luyện, thành lập thế lực riêng', conflict: 'Thu phục nhân tài và xây dựng căn cơ' },
    { title: 'Phản Kích & Khẳng Định', theme: 'Trở lại quét sạch kẻ thù cũ, lập lại trật tự', conflict: 'Đại chiến thanh trừng ân oán' },
    { title: 'Bí Mật Thiên Địa', theme: 'Tiếp cận chân tướng của thế giới và lịch sử cổ đại', conflict: 'Chống lại các thế lực ngầm thao túng vận mệnh' },
    { title: 'Đại Họa Giáng Lâm', theme: 'Hiểm họa toàn cầu / tam giới bùng nổ', conflict: 'Tập hợp đồng minh ngăn chặn sự diệt vong' },
    { title: 'Đỉnh Cao Phong Ma', theme: 'Trận chiến quyết định vận mệnh thế giới', conflict: 'Đối đầu trực diện với thế lực tột cùng' }
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
      id: 'fact_magic_rules',
      category: 'magic_system',
      fact: bible.worldNotes || 'Hệ thống tu luyện theo từng cảnh giới nghiêm ngặt.',
      scope: 'public',
      introducedAtChapter: 1
    },
    {
      id: 'fact_world_geography',
      category: 'geography',
      fact: 'Bối cảnh thế giới phân tầng từ hạ giới lên thượng giới.',
      scope: 'public',
      introducedAtChapter: 1
    }
  ];

  const narrativeExposureRules: NarrativeExposureRules = {
    prohibitedTopicsUntilChapter: [
      { topic: 'Bí mật tối thượng về nguồn gốc đại lục', unlockChapter: Math.floor(totalChapters * 0.6) },
      { topic: 'Sự thật về các vị thần cổ đại', unlockChapter: Math.floor(totalChapters * 0.75) }
    ],
    foreshadowingDirectives: [
      { hint: 'Gợi ý nhẹ nhàng về sự mất cân bằng linh khí', plantArcId: 'arc_1', payoffArcId: 'arc_3' }
    ],
    mandatoryKnowledgeByChapter: []
  };

  return {
    version: 'v3',
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
    }
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
  (control.characterGates || []).forEach(gate => {
    if (gate.unlockAtChapter <= Math.max(1, currentChapter)) {
      unlockedCharacterIds.add(gate.characterId);
    }
  });
  (currentArc.unlockedCharacterIds || []).forEach(id => unlockedCharacterIds.add(id));
  initialCharacters.forEach(c => unlockedCharacterIds.add(c.id));

  // Trạng thái World Facts ban đầu
  const worldFactStates: Record<string, 'hidden' | 'foreshadowed' | 'revealed'> = {};
  (control.worldFacts || []).forEach(wf => {
    if (wf.introducedAtChapter <= Math.max(1, currentChapter)) {
      worldFactStates[wf.id] = 'revealed';
    } else {
      worldFactStates[wf.id] = 'hidden';
    }
  });

  return {
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
    activeFactions: []
  };
}
