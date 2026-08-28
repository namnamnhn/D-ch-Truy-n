import { Character, CreativeChapter } from '../../types';
import {
  ChapterMemory,
  CharacterInjury,
  CharacterState,
  LongTermSeed,
  StoryClue,
  StoryControl,
  StoryRelationship,
  StoryState
} from './types';
import { getCurrentArc, calculateArcProgress } from './arcController';
import {
  isRecord,
  normalizeFiniteNumber,
  normalizePositiveInteger,
  normalizeStringArray,
  normalizeText,
  stripJsonFence
} from './runtimeValidation';

type InjurySeverity = CharacterInjury['severity'];

export interface StateInjuryDelta {
  characterName: string;
  type: string;
  bodyPart: string;
  severity: InjurySeverity;
  durationChapters: number;
  restrictions: string[];
}

export interface StateRelationshipDelta {
  characterA: string;
  characterB: string;
  trust?: number;
  hostility?: number;
  stage?: string;
  notes?: string;
}

export interface StateClueDelta {
  clue: string;
  discoveredBy?: string;
  interpretations: string[];
  actualTruthHidden?: string;
}

export interface StateSeedDelta {
  meaningHidden: string;
  eligibleCallbackFromChapter?: number;
}

export interface StateCharacterDelta {
  name: string;
  gender?: string;
  age?: string;
  role?: string;
  appearance?: string;
  personality?: string;
}

export interface StateChapterSummaryDelta {
  chapterNumber: number;
  summary?: string;
  charactersInvolved: string[];
  locations: string[];
  clues: string[];
  injuries: string[];
  relationshipChanges: string[];
  resources: string[];
  longTermSeeds: string[];
}

export interface StateDeltaV3 {
  injuries: StateInjuryDelta[];
  relationships: StateRelationshipDelta[];
  resources: {
    money?: string;
    businesses?: string[];
    properties?: string[];
    equipment?: string[];
  };
  clues: StateClueDelta[];
  seeds: StateSeedDelta[];
  unresolvedThreads: string[];
  resolvedThreads: string[];
  newCharacters: StateCharacterDelta[];
  chapterSummaries: StateChapterSummaryDelta[];
  batchSummary?: string;
}

export interface StateDeltaParseResult {
  delta: StateDeltaV3;
  warnings: string[];
  usedFallback: boolean;
}

function emptyStateDelta(): StateDeltaV3 {
  return {
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
}

function warnAboutDiscardedArrayItems(
  value: unknown,
  normalizedLength: number,
  field: string,
  warnings: string[]
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    warnings.push(`${field} bị bỏ vì không phải array.`);
    return;
  }
  if (value.length > normalizedLength) warnings.push(`${field} có phần tử sai type đã bị bỏ.`);
}

function normalizeBoundedNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  const number = normalizeFiniteNumber(value);
  if (number === null) return undefined;
  return Math.min(maximum, Math.max(minimum, number));
}

function normalizeInjuries(value: unknown, warnings: string[]): StateInjuryDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateInjuryDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`injuries[${index}] bị bỏ vì không phải object.`);
      return;
    }
    const characterName = normalizeText(entry.characterName);
    if (!characterName) {
      warnings.push(`injuries[${index}] bị bỏ vì characterName không hợp lệ.`);
      return;
    }
    const validSeverities: InjurySeverity[] = ['mild', 'moderate', 'severe', 'critical'];
    const severity = validSeverities.find(item => item === entry.severity) || 'moderate';
    result.push({
      characterName,
      type: normalizeText(entry.type) || 'Chấn thương',
      bodyPart: normalizeText(entry.bodyPart) || 'Cơ thể',
      severity,
      durationChapters: normalizePositiveInteger(entry.durationChapters) || (severity === 'severe' ? 10 : 5),
      restrictions: normalizeStringArray(entry.restrictions)
    });
  });
  return result;
}

function normalizeRelationships(value: unknown, warnings: string[]): StateRelationshipDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateRelationshipDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`relationships[${index}] bị bỏ vì không phải object.`);
      return;
    }
    const characterA = normalizeText(entry.characterA);
    const characterB = normalizeText(entry.characterB);
    if (!characterA || !characterB) {
      warnings.push(`relationships[${index}] bị bỏ vì tên nhân vật không hợp lệ.`);
      return;
    }
    result.push({
      characterA,
      characterB,
      trust: normalizeBoundedNumber(entry.trust, 0, 100),
      hostility: normalizeBoundedNumber(entry.hostility, 0, 100),
      stage: normalizeText(entry.stage) || undefined,
      notes: normalizeText(entry.notes) || undefined
    });
  });
  return result;
}

function normalizeClues(value: unknown, warnings: string[]): StateClueDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateClueDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`clues[${index}] bị bỏ vì không phải object.`);
      return;
    }
    const clue = normalizeText(entry.clue);
    if (!clue) {
      warnings.push(`clues[${index}] bị bỏ vì clue không hợp lệ.`);
      return;
    }
    result.push({
      clue,
      discoveredBy: normalizeText(entry.discoveredBy) || undefined,
      interpretations: normalizeStringArray(entry.interpretations),
      actualTruthHidden: normalizeText(entry.actualTruthHidden) || undefined
    });
  });
  return result;
}

function normalizeSeeds(value: unknown, warnings: string[]): StateSeedDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateSeedDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`seeds[${index}] bị bỏ vì không phải object.`);
      return;
    }
    const meaningHidden = normalizeText(entry.meaningHidden);
    if (!meaningHidden) {
      warnings.push(`seeds[${index}] bị bỏ vì meaningHidden không hợp lệ.`);
      return;
    }
    result.push({
      meaningHidden,
      eligibleCallbackFromChapter: normalizePositiveInteger(entry.eligibleCallbackFromChapter) || undefined
    });
  });
  return result;
}

function normalizeNewCharacters(value: unknown, warnings: string[]): StateCharacterDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateCharacterDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`newCharacters[${index}] bị bỏ vì không phải object.`);
      return;
    }
    const name = normalizeText(entry.name);
    if (!name) {
      warnings.push(`newCharacters[${index}] bị bỏ vì name không hợp lệ.`);
      return;
    }
    result.push({
      name,
      gender: normalizeText(entry.gender) || undefined,
      age: normalizeText(entry.age) || (typeof entry.age === 'number' && Number.isFinite(entry.age) ? String(entry.age) : undefined),
      role: normalizeText(entry.role) || undefined,
      appearance: normalizeText(entry.appearance) || undefined,
      personality: normalizeText(entry.personality) || undefined
    });
  });
  return result;
}

function normalizeChapterSummaries(value: unknown, warnings: string[]): StateChapterSummaryDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateChapterSummaryDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`chapterSummaries[${index}] bị bỏ vì không phải object.`);
      return;
    }
    const chapterNumber = normalizePositiveInteger(entry.chapterNumber);
    if (chapterNumber === null) {
      warnings.push(`chapterSummaries[${index}] bị bỏ vì chapterNumber không hợp lệ.`);
      return;
    }
    result.push({
      chapterNumber,
      summary: normalizeText(entry.summary) || undefined,
      charactersInvolved: normalizeStringArray(entry.charactersInvolved),
      locations: normalizeStringArray(entry.locations),
      clues: normalizeStringArray(entry.clues),
      injuries: normalizeStringArray(entry.injuries),
      relationshipChanges: normalizeStringArray(entry.relationshipChanges),
      resources: normalizeStringArray(entry.resources),
      longTermSeeds: normalizeStringArray(entry.longTermSeeds)
    });
  });
  return result;
}

function normalizeResources(value: unknown): StateDeltaV3['resources'] {
  if (!isRecord(value)) return {};
  return {
    money: normalizeText(value.money) || undefined,
    businesses: normalizeStringArray(value.businesses),
    properties: normalizeStringArray(value.properties),
    equipment: normalizeStringArray(value.equipment)
  };
}

export function normalizeStateDelta(value: unknown): StateDeltaParseResult {
  const fallback = emptyStateDelta();
  if (!isRecord(value)) {
    return { delta: fallback, warnings: ['State delta root không phải object.'], usedFallback: true };
  }
  const warnings: string[] = [];
  const unresolvedThreads = normalizeStringArray(value.unresolvedThreads);
  const resolvedThreads = normalizeStringArray(value.resolvedThreads);
  const delta: StateDeltaV3 = {
    injuries: normalizeInjuries(value.injuries, warnings),
    relationships: normalizeRelationships(value.relationships, warnings),
    resources: normalizeResources(value.resources),
    clues: normalizeClues(value.clues, warnings),
    seeds: normalizeSeeds(value.seeds, warnings),
    unresolvedThreads,
    resolvedThreads,
    newCharacters: normalizeNewCharacters(value.newCharacters, warnings),
    chapterSummaries: normalizeChapterSummaries(value.chapterSummaries, warnings),
    batchSummary: normalizeText(value.batchSummary) || undefined
  };
  warnAboutDiscardedArrayItems(value.unresolvedThreads, unresolvedThreads.length, 'unresolvedThreads', warnings);
  warnAboutDiscardedArrayItems(value.resolvedThreads, resolvedThreads.length, 'resolvedThreads', warnings);
  if (value.resources !== undefined && !isRecord(value.resources)) warnings.push('resources bị bỏ vì không phải object.');
  if (value.batchSummary !== undefined && !delta.batchSummary) warnings.push('batchSummary bị bỏ vì không phải chuỗi hợp lệ.');
  return { delta, warnings, usedFallback: false };
}

export function parseStateDeltaResponse(rawResponse: string): StateDeltaParseResult {
  try {
    const parsed: unknown = JSON.parse(stripJsonFence(rawResponse));
    return normalizeStateDelta(parsed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      delta: emptyStateDelta(),
      warnings: [`State Extractor trả JSON không hợp lệ: ${detail}`],
      usedFallback: true
    };
  }
}

function normalizeExistingInjuries(value: unknown, endChapter: number): CharacterInjury[] {
  if (!Array.isArray(value)) return [];
  const result: CharacterInjury[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const receivedChapter = normalizePositiveInteger(entry.receivedChapter);
    const expectedRecoveryChapter = normalizePositiveInteger(entry.expectedRecoveryChapter);
    if (receivedChapter === null || expectedRecoveryChapter === null || expectedRecoveryChapter <= endChapter) continue;
    const severities: InjurySeverity[] = ['mild', 'moderate', 'severe', 'critical'];
    result.push({
      type: normalizeText(entry.type) || 'Chấn thương',
      bodyPart: normalizeText(entry.bodyPart) || 'Cơ thể',
      severity: severities.find(item => item === entry.severity) || 'moderate',
      receivedChapter,
      expectedRecoveryChapter,
      restrictions: normalizeStringArray(entry.restrictions)
    });
  }
  return result;
}

function cloneCharacterStates(value: unknown, endChapter: number): Record<string, CharacterState> {
  if (!isRecord(value)) return {};
  const result: Record<string, CharacterState> = {};
  for (const [rawKey, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const name = normalizeText(entry.name) || normalizeText(rawKey);
    if (!name) continue;
    const key = name.toLocaleLowerCase('vi-VN');
    result[key] = {
      characterId: normalizeText(entry.characterId) || key,
      name,
      location: normalizeText(entry.location) || '',
      physicalCondition: normalizeText(entry.physicalCondition) || '',
      injuries: normalizeExistingInjuries(entry.injuries, endChapter),
      knownFacts: normalizeStringArray(entry.knownFacts),
      goals: normalizeStringArray(entry.goals),
      activeFaction: normalizeText(entry.activeFaction) || undefined
    };
  }
  return result;
}

function normalizeExistingRelationships(value: unknown): StoryRelationship[] {
  if (!Array.isArray(value)) return [];
  const result: StoryRelationship[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const characterA = normalizeText(entry.characterA);
    const characterB = normalizeText(entry.characterB);
    if (!characterA || !characterB) continue;
    result.push({
      characterA,
      characterB,
      trust: normalizeBoundedNumber(entry.trust, 0, 100) ?? 50,
      hostility: normalizeBoundedNumber(entry.hostility, 0, 100) ?? 10,
      stage: normalizeText(entry.stage) || 'Quen biết',
      debt: normalizeText(entry.debt) || undefined,
      lastMajorChangeChapter: normalizePositiveInteger(entry.lastMajorChangeChapter) || 1
    });
  }
  return result;
}

function normalizeExistingClues(value: unknown): StoryClue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry, index) => ({
    id: normalizeText(entry.id) || `existing_clue_${index + 1}`,
    clue: normalizeText(entry.clue) || '',
    discoveredChapter: normalizePositiveInteger(entry.discoveredChapter) || 1,
    discoveredBy: normalizeText(entry.discoveredBy) || 'Không rõ',
    knownInterpretations: normalizeStringArray(entry.knownInterpretations),
    actualTruthHidden: normalizeText(entry.actualTruthHidden) || '',
    resolved: entry.resolved === true
  })).filter(clue => clue.clue);
}

function normalizeExistingSeeds(value: unknown): LongTermSeed[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry, index) => {
    const status: LongTermSeed['status'] = entry.status === 'foreshadowed' || entry.status === 'resolved'
      ? entry.status : 'planted';
    return {
      id: normalizeText(entry.id) || `existing_seed_${index + 1}`,
      plantedChapter: normalizePositiveInteger(entry.plantedChapter) || 1,
      meaningHidden: normalizeText(entry.meaningHidden) || '',
      eligibleCallbackFromChapter: normalizePositiveInteger(entry.eligibleCallbackFromChapter) || 1,
      status
    };
  }).filter(seed => seed.meaningHidden);
}

function pairKey(characterA: string, characterB: string): string {
  return [characterA.toLocaleLowerCase('vi-VN'), characterB.toLocaleLowerCase('vi-VN')].sort().join('###');
}

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
  let parseResult: StateDeltaParseResult = { delta: emptyStateDelta(), warnings: [], usedFallback: true };

  if (runner) {
    const sys = `Bạn là Story State Extractor. Chỉ trả JSON State Delta V3. Không tự tạo author truth.`;
    const prompt = `[CÁC CHƯƠNG ĐÃ NGHIỆM THU]\n${acceptedChapters
      .map((chapter, index) => `=== CHƯƠNG ${startChapter + index}: ${chapter.title} ===\n${chapter.content}`)
      .join('\n\n')}\n\nHãy trích xuất JSON delta.`;
    try {
      parseResult = parseStateDeltaResponse(await runner(prompt, sys));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      parseResult = { delta: emptyStateDelta(), warnings: [`State Extractor runner lỗi: ${detail}`], usedFallback: true };
    }
  }
  if (parseResult.warnings.length) {
    console.warn('[extractAndMergeState] State delta được chuẩn hóa:', parseResult.warnings.join(' '));
  }
  const delta = parseResult.delta;

  const nextCharacterStates = cloneCharacterStates(previousState.characterStates, endChapter);
  for (const injury of delta.injuries) {
    const key = injury.characterName.toLocaleLowerCase('vi-VN');
    if (!nextCharacterStates[key]) {
      nextCharacterStates[key] = {
        characterId: key,
        name: injury.characterName,
        location: 'Hiện trường',
        physicalCondition: 'Bị thương',
        injuries: [],
        knownFacts: [],
        goals: []
      };
    }
    nextCharacterStates[key].injuries.push({
      type: injury.type,
      bodyPart: injury.bodyPart,
      severity: injury.severity,
      receivedChapter: startChapter,
      expectedRecoveryChapter: startChapter + injury.durationChapters,
      restrictions: injury.restrictions.length ? injury.restrictions : ['Hạn chế vận động mạnh']
    });
  }

  const relationshipsMap = new Map<string, StoryRelationship>();
  for (const relationship of normalizeExistingRelationships(previousState.relationships)) {
    relationshipsMap.set(pairKey(relationship.characterA, relationship.characterB), relationship);
  }
  for (const relationship of delta.relationships) {
    relationshipsMap.set(pairKey(relationship.characterA, relationship.characterB), {
      characterA: relationship.characterA,
      characterB: relationship.characterB,
      trust: relationship.trust ?? 50,
      hostility: relationship.hostility ?? 10,
      stage: relationship.stage || 'Quen biết',
      debt: relationship.notes,
      lastMajorChangeChapter: endChapter
    });
  }

  const clues = normalizeExistingClues(previousState.clues);
  for (const clue of delta.clues) {
    clues.push({
      id: `clue_${startChapter}_${clues.length + 1}`,
      clue: clue.clue,
      discoveredChapter: startChapter,
      discoveredBy: clue.discoveredBy || 'Nhân vật chính',
      knownInterpretations: clue.interpretations,
      actualTruthHidden: clue.actualTruthHidden || '',
      resolved: false
    });
  }

  const longTermSeeds = normalizeExistingSeeds(previousState.longTermSeeds);
  for (const seed of delta.seeds) {
    longTermSeeds.push({
      id: `seed_${startChapter}_${longTermSeeds.length + 1}`,
      plantedChapter: startChapter,
      meaningHidden: seed.meaningHidden,
      eligibleCallbackFromChapter: seed.eligibleCallbackFromChapter || startChapter + 30,
      status: 'planted'
    });
  }

  const resolvedSet = new Set(delta.resolvedThreads.map(thread => thread.toLocaleLowerCase('vi-VN')));
  const unresolvedThreads = normalizeStringArray(previousState.unresolvedThreads)
    .filter(thread => !resolvedSet.has(thread.toLocaleLowerCase('vi-VN')));
  for (const thread of delta.unresolvedThreads) {
    if (!unresolvedThreads.includes(thread)) unresolvedThreads.push(thread);
  }

  const existingNames = new Set<string>();
  for (const character of Array.isArray(existingCharacters) ? existingCharacters : []) {
    const name = normalizeText(character?.name);
    if (name) existingNames.add(name.toLocaleLowerCase('vi-VN'));
  }
  const newCharacters: Character[] = [];
  for (const character of delta.newCharacters) {
    const normalizedName = character.name.toLocaleLowerCase('vi-VN');
    if (existingNames.has(normalizedName)) continue;
    existingNames.add(normalizedName);
    newCharacters.push({
      id: `char_${startChapter}_${newCharacters.length + 1}`,
      name: character.name,
      gender: character.gender || 'Chưa rõ',
      age: character.age || 'Chưa rõ',
      role: character.role || 'Nhân vật phụ',
      appearance: character.appearance || '',
      personality: character.personality || ''
    });
  }

  const unlockedCharacterIds = new Set(normalizeStringArray(previousState.unlockedCharacterIds));
  for (const gate of control.characterGates || []) {
    if (gate.unlockAtChapter <= endChapter) unlockedCharacterIds.add(gate.characterId);
  }
  for (const id of currentArc.unlockedCharacterIds || []) unlockedCharacterIds.add(id);

  const worldFactStates: StoryState['worldFactStates'] = {};
  if (isRecord(previousState.worldFactStates)) {
    for (const [factId, status] of Object.entries(previousState.worldFactStates)) {
      if (status === 'hidden' || status === 'foreshadowed' || status === 'revealed') worldFactStates[factId] = status;
    }
  }
  for (const fact of control.worldFacts || []) {
    if (fact.introducedAtChapter <= endChapter) {
      if (!worldFactStates[fact.id] || worldFactStates[fact.id] === 'hidden') worldFactStates[fact.id] = 'revealed';
    } else if (!worldFactStates[fact.id]) {
      worldFactStates[fact.id] = 'hidden';
    }
  }

  const newMemories: ChapterMemory[] = acceptedChapters.map((chapter, index) => {
    const chapterNumber = startChapter + index;
    const aiMemory = delta.chapterSummaries.find(summary => summary.chapterNumber === chapterNumber);
    return {
      chapterNumber,
      title: normalizeText(chapter.title) || `Chương ${chapterNumber}`,
      summary: aiMemory?.summary || `${chapter.content.slice(0, 300)}...`,
      charactersInvolved: aiMemory?.charactersInvolved || [],
      locations: aiMemory?.locations || [],
      clues: aiMemory?.clues || [],
      relationshipChanges: aiMemory?.relationshipChanges || [],
      injuries: aiMemory?.injuries || [],
      resources: aiMemory?.resources || [],
      longTermSeeds: aiMemory?.longTermSeeds || []
    };
  });

  const batchSummary = delta.batchSummary || normalizeText(rawSummary)
    || acceptedChapters.map(chapter => normalizeText(chapter.title)).filter((title): title is string => title !== null).join('; ');
  const updatedContinuitySummary = previousState.currentChapter === 0
    ? `Tiến trình khởi đầu (Chương 1-${endChapter}): ${batchSummary}`
    : `(Đến chương ${endChapter}): ${batchSummary}`;

  const previousResources = isRecord(previousState.resources) ? previousState.resources : {};
  const resources: StoryState['resources'] = {};
  for (const [key, value] of Object.entries(previousResources)) {
    const text = normalizeText(value);
    if (text) resources[key] = text;
    else if (Array.isArray(value)) resources[key] = normalizeStringArray(value);
  }
  if (delta.resources.money) resources.money = delta.resources.money;
  if (delta.resources.businesses?.length) resources.businesses = delta.resources.businesses;
  if (delta.resources.properties?.length) resources.properties = delta.resources.properties;
  if (delta.resources.equipment?.length) resources.equipment = delta.resources.equipment;
  const recentConsequences = [
    ...normalizeStringArray(previousState.recentConsequences),
    ...delta.injuries.map(injury => `${injury.characterName} bị thương ở ${injury.bodyPart}`)
  ].slice(-20);
  const nextState: StoryState = {
    currentChapter: endChapter,
    characterStates: nextCharacterStates,
    relationships: Array.from(relationshipsMap.values()),
    resources,
    clues,
    unresolvedThreads: unresolvedThreads.slice(-15),
    longTermSeeds,
    recentConsequences,
    currentArcId: currentArc.id,
    currentArcProgress: arcProgress,
    unlockedCharacterIds: Array.from(unlockedCharacterIds),
    worldFactStates,
    activeFactions: normalizeStringArray(previousState.activeFactions)
  };

  return { nextState, newCharacters, updatedContinuitySummary, newMemories };
}
