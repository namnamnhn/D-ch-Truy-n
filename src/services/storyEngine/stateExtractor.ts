import { Character, CreativeChapter } from '../../types';
import { StoryState, StoryControl, ChapterMemory, CharacterInjury, StoryRelationship, StoryClue, LongTermSeed } from './types';
import { getCurrentArc, calculateArcProgress } from './arcController';

/**
 * State Extractor V3:
 * Chạy sau khi batch chương được nghiệm thu (QA Pass).
 * Dùng Flash model (hoặc fallback deterministic) để bóc tách state delta,
 * sau đó thực hiện deterministic merge vào StoryState và tạo ChapterMemory index.
 */
export async function extractAndMergeState(
  acceptedChapters: CreativeChapter[],
  previousState: StoryState,
  control: StoryControl,
  existingCharacters: Character[],
  rawSummary: string | undefined,
  startChapter: number,
  runner?: (prompt: string, sys: string) => Promise<string>
): Promise<{
  nextState: StoryState;
  newCharacters: Character[];
  updatedContinuitySummary: string;
  newMemories: ChapterMemory[];
}> {
  const currentArc = getCurrentArc(control, startChapter);
  const endChapter = startChapter + acceptedChapters.length - 1;
  const { arcProgress } = calculateArcProgress(currentArc, endChapter);

  let delta: any = {
    injuries: [],
    relationships: [],
    resources: {},
    clues: [],
    seeds: [],
    unresolvedThreads: [],
    resolvedThreads: [],
    newCharacters: [],
    chapterSummaries: []
  };

  if (runner) {
    const sys = `Bạn là Story State Extractor cho hệ thống tiểu thuyết dài tập (Story Engine V3).
Nhiệm vụ của bạn là phân tích các chương vừa được nghiệm thu và trích xuất các biến động trạng thái (State Delta) chính xác dưới dạng JSON.

CÁC TRƯỜNG CẦN TRÍCH XUẤT:
1. injuries: danh sách thương tích mới phát sinh [{ characterName, type, bodyPart, severity ('mild'|'moderate'|'severe'|'critical'), durationChapters, restrictions }]
2. relationships: thay đổi quan hệ [{ characterA, characterB, trust, hostility, stage, notes }]
3. resources: biến động tiền bạc, vật phẩm, tài nguyên
4. clues: manh mối phát hiện [{ clue, discoveredBy, interpretations, actualTruthHidden }]
5. seeds: hạt giống cài cắm dài hạn [{ meaningHidden, eligibleCallbackFromChapter }]
6. unresolvedThreads: những vấn đề mới mở ra
7. resolvedThreads: những vấn đề đã được giải quyết xong trong batch này
8. newCharacters: nhân vật phụ mới [{ name, gender, age, role, appearance, personality }]
9. chapterSummaries: tóm tắt từng chương [{ chapterNumber, title, summary, charactersInvolved, locations, clues, injuries, relationshipChanges, resources, longTermSeeds }]
10. batchSummary: tóm tắt cô đọng 2-3 câu về tiến trình toàn batch`;

    const prompt = `[CÁC CHƯƠNG ĐÃ NGHIỆM THU]
${acceptedChapters.map((c, i) => `=== CHƯƠNG ${startChapter + i}: ${c.title} ===\n${c.content}\n`).join('\n\n')}

Hãy trích xuất JSON delta:`;

    try {
      const rawRes = await runner(prompt, sys);
      const cleaned = rawRes.replace(/```json/g, '').replace(/```/g, '').trim();
      delta = JSON.parse(cleaned);
    } catch (err) {
      console.warn('[extractAndMergeState] AI State Extraction failed, falling back to deterministic extraction:', err);
    }
  }

  // --- DETERMINISTIC MERGE LOGIC ---
  const nextCharacterStates = { ...(previousState.characterStates || {}) };

  // 1. Cập nhật và làm sạch các vết thương (Injuries)
  for (const csKey of Object.keys(nextCharacterStates)) {
    const cs = nextCharacterStates[csKey];
    if (cs.injuries) {
      // Bỏ các vết thương đã quá hạn phục hồi
      cs.injuries = cs.injuries.filter(inj => inj.expectedRecoveryChapter > endChapter);
    }
  }

  // Thêm vết thương mới
  if (Array.isArray(delta?.injuries)) {
    for (const inj of delta.injuries) {
      const charName = inj.characterName || 'Nhân vật chính';
      const key = charName.toLowerCase().trim();
      if (!nextCharacterStates[key]) {
        nextCharacterStates[key] = {
          characterId: key,
          name: charName,
          location: 'Hiện trường',
          physicalCondition: 'Bị thương',
          injuries: [],
          knownFacts: [],
          goals: []
        };
      }
      const duration = typeof inj.durationChapters === 'number' ? inj.durationChapters : (inj.severity === 'severe' ? 10 : 5);
      const newInj: CharacterInjury = {
        type: inj.type || 'Chấn thương',
        bodyPart: inj.bodyPart || 'Thân thể',
        severity: inj.severity || 'moderate',
        receivedChapter: startChapter,
        expectedRecoveryChapter: startChapter + duration,
        restrictions: Array.isArray(inj.restrictions) ? inj.restrictions : ['Hạn chế vận động mạnh']
      };
      nextCharacterStates[key].injuries.push(newInj);
    }
  }

  // 2. Cập nhật mối quan hệ (Relationships)
  const relationshipsMap = new Map<string, StoryRelationship>();
  for (const r of (previousState.relationships || [])) {
    const pairKey = [r.characterA, r.characterB].sort().join('###');
    relationshipsMap.set(pairKey, r);
  }

  if (Array.isArray(delta?.relationships)) {
    for (const rel of delta.relationships) {
      if (rel.characterA && rel.characterB) {
        const pairKey = [rel.characterA, rel.characterB].sort().join('###');
        relationshipsMap.set(pairKey, {
          characterA: rel.characterA,
          characterB: rel.characterB,
          trust: typeof rel.trust === 'number' ? rel.trust : 50,
          hostility: typeof rel.hostility === 'number' ? rel.hostility : 10,
          stage: rel.stage || 'Quen biết',
          debt: rel.notes,
          lastMajorChangeChapter: endChapter
        });
      }
    }
  }

  // 3. Cập nhật manh mối (Clues)
  const clues: StoryClue[] = [...(previousState.clues || [])];
  if (Array.isArray(delta?.clues)) {
    for (const c of delta.clues) {
      if (c.clue) {
        clues.push({
          id: `clue_${Date.now()}_${clues.length + 1}`,
          clue: c.clue,
          discoveredChapter: startChapter,
          discoveredBy: c.discoveredBy || 'Nhân vật chính',
          knownInterpretations: Array.isArray(c.interpretations) ? c.interpretations : [],
          actualTruthHidden: c.actualTruthHidden || '',
          resolved: false
        });
      }
    }
  }

  // 4. Cập nhật hạt giống dài hạn (Long Term Seeds)
  const longTermSeeds: LongTermSeed[] = [...(previousState.longTermSeeds || [])];
  if (Array.isArray(delta?.seeds)) {
    for (const s of delta.seeds) {
      if (s.meaningHidden) {
        longTermSeeds.push({
          id: `seed_${Date.now()}_${longTermSeeds.length + 1}`,
          plantedChapter: startChapter,
          meaningHidden: s.meaningHidden,
          eligibleCallbackFromChapter: typeof s.eligibleCallbackFromChapter === 'number' ? s.eligibleCallbackFromChapter : startChapter + 30,
          status: 'planted'
        });
      }
    }
  }

  // 5. Cập nhật unresolved threads
  let unresolvedThreads = [...(previousState.unresolvedThreads || [])];
  if (Array.isArray(delta?.resolvedThreads)) {
    const resolvedSet = new Set(delta.resolvedThreads.map((t: string) => t.toLowerCase().trim()));
    unresolvedThreads = unresolvedThreads.filter(t => !resolvedSet.has(t.toLowerCase().trim()));
  }
  if (Array.isArray(delta?.unresolvedThreads)) {
    for (const t of delta.unresolvedThreads) {
      if (typeof t === 'string' && t.trim() && !unresolvedThreads.includes(t.trim())) {
        unresolvedThreads.push(t.trim());
      }
    }
  }

  // 6. Trích xuất nhân vật mới và khử trùng lặp theo tên chuẩn hóa
  const existingNames = new Set(existingCharacters.map(c => c.name.toLowerCase().trim()));
  const newCharacters: Character[] = [];

  if (Array.isArray(delta?.newCharacters)) {
    for (const nc of delta.newCharacters) {
      const norm = (nc.name || '').toLowerCase().trim();
      if (norm && !existingNames.has(norm)) {
        existingNames.add(norm);
        newCharacters.push({
          id: `char_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
          name: nc.name.trim(),
          gender: nc.gender || 'Chưa rõ',
          age: nc.age || 'Chưa rõ',
          role: nc.role || 'Nhân vật phụ',
          appearance: nc.appearance || '',
          personality: nc.personality || ''
        });
      }
    }
  }

  // 7. Mở khóa nhân vật theo chương và Arc (Unlocked Characters)
  const unlockedCharacterIds = new Set<string>(previousState.unlockedCharacterIds || []);
  (control.characterGates || []).forEach(gate => {
    if (gate.unlockAtChapter <= endChapter) {
      unlockedCharacterIds.add(gate.characterId);
    }
  });
  // Thêm các nhân vật thuộc Arc hiện tại
  (currentArc.unlockedCharacterIds || []).forEach(id => unlockedCharacterIds.add(id));

  // 8. Cập nhật World Fact States
  const worldFactStates = { ...(previousState.worldFactStates || {}) };
  (control.worldFacts || []).forEach(wf => {
    if (wf.introducedAtChapter <= endChapter) {
      if (!worldFactStates[wf.id] || worldFactStates[wf.id] === 'hidden') {
        worldFactStates[wf.id] = 'revealed';
      }
    } else {
      if (!worldFactStates[wf.id]) {
        worldFactStates[wf.id] = 'hidden';
      }
    }
  });

  // 9. Tạo ChapterMemory index
  const newMemories: ChapterMemory[] = [];
  for (let i = 0; i < acceptedChapters.length; i++) {
    const chNum = startChapter + i;
    const ch = acceptedChapters[i];
    const aiMem = Array.isArray(delta?.chapterSummaries) ? delta.chapterSummaries.find((s: any) => s.chapterNumber === chNum) : null;

    newMemories.push({
      chapterNumber: chNum,
      title: ch.title,
      summary: aiMem?.summary || ch.content.slice(0, 300) + '...',
      charactersInvolved: aiMem?.charactersInvolved || [],
      locations: aiMem?.locations || [],
      clues: aiMem?.clues || [],
      relationshipChanges: aiMem?.relationshipChanges || [],
      injuries: aiMem?.injuries || [],
      resources: aiMem?.resources || [],
      longTermSeeds: aiMem?.longTermSeeds || []
    });
  }

  // 10. Cập nhật continuitySummary (kế thừa và nối tiếp)
  const batchSummaryText = delta?.batchSummary || rawSummary || acceptedChapters.map(c => c.title).join('; ');
  const updatedContinuitySummary = previousState.currentChapter === 0
    ? `Tiến trình khởi đầu (Chương 1-${endChapter}): ${batchSummaryText}`
    : `(Đến chương ${endChapter}): ${batchSummaryText}`;

  const nextState: StoryState = {
    currentChapter: endChapter,
    characterStates: nextCharacterStates,
    relationships: Array.from(relationshipsMap.values()),
    resources: {
      money: delta?.resources?.money || previousState.resources?.money,
      businesses: delta?.resources?.businesses || previousState.resources?.businesses,
      properties: delta?.resources?.properties || previousState.resources?.properties,
      equipment: delta?.resources?.equipment || previousState.resources?.equipment
    },
    clues,
    unresolvedThreads: unresolvedThreads.slice(-15),
    longTermSeeds,
    recentConsequences: (delta?.injuries || []).map((inj: any) => `${inj.characterName} bị thương ở ${inj.bodyPart}`),
    currentArcId: currentArc.id,
    currentArcProgress: arcProgress,
    unlockedCharacterIds: Array.from(unlockedCharacterIds),
    worldFactStates
  };

  return {
    nextState,
    newCharacters,
    updatedContinuitySummary,
    newMemories
  };
}
