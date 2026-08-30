import { Character, CreativeChapter } from '../../types';
import {
  ChapterMemory,
  CharacterInjury,
  CharacterState,
  KnowledgeEntry,
  LongTermSeed,
  StoryClue,
  StoryControl,
  StoryConsequence,
  StoryRelationship,
  StoryState,
  STORY_STATE_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION
} from './types';
import { calculateArcProgress } from './arcController';
import { getArcForChapter, getCharacterAccess, isWorldFactAvailable } from './storyAccess';
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
  injuryId?: string;
  status?: CharacterInjury['status'];
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
}

export interface StateKnowledgeDelta {
  factId?: string;
  fact: string;
  characterId?: string;
  learnedChapter?: number;
  source: string;
  confidence: number;
  interpretation?: string;
  status?: KnowledgeEntry['status'];
}

export interface StateTimelineDelta {
  chapterNumber?: number;
  marker: string;
  relativeChronology?: string;
  location?: string;
  previousLocation?: string;
  event?: string;
  characterName?: string;
}

export interface StateConsequenceDelta {
  id?: string;
  type: string;
  description: string;
  status?: 'active' | 'resolved';
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
  knowledge: StateKnowledgeDelta[];
  timeline: StateTimelineDelta[];
  consequences: StateConsequenceDelta[];
  resolvedConsequenceIds: string[];
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
    chapterSummaries: [],
    knowledge: [],
    timeline: []
    ,consequences: []
    ,resolvedConsequenceIds: []
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
      restrictions: normalizeStringArray(entry.restrictions),
      injuryId: normalizeText(entry.injuryId) || normalizeText(entry.id) || undefined,
      status: entry.status === 'improving' || entry.status === 'worsening' || entry.status === 'recovered'
        || entry.status === 'permanent' || entry.status === 'active' ? entry.status : undefined
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
      interpretations: normalizeStringArray(entry.interpretations)
    });
  });
  return result;
}

function normalizeKnowledge(value: unknown, warnings: string[]): StateKnowledgeDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateKnowledgeDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`knowledge[${index}] dropped: expected object.`);
      return;
    }
    const fact = normalizeText(entry.fact) || normalizeText(entry.interpretation);
    if (!fact) {
      warnings.push(`knowledge[${index}] dropped: missing observable fact.`);
      return;
    }
    const source = normalizeText(entry.source) || 'unknown';
    const confidence = normalizeBoundedNumber(entry.confidence, 0, 1) ?? 0.5;
    const status: KnowledgeEntry['status'] | undefined = entry.status === 'believed'
      || entry.status === 'questioned' || entry.status === 'retracted' || entry.status === 'confirmed'
      ? entry.status : undefined;
    result.push({
      factId: normalizeText(entry.factId) || undefined,
      fact,
      characterId: normalizeText(entry.characterId) || normalizeText(entry.characterName) || undefined,
      learnedChapter: normalizePositiveInteger(entry.learnedChapter) || undefined,
      source,
      confidence,
      interpretation: normalizeText(entry.interpretation) || undefined,
      status
    });
  });
  return result;
}

function normalizeTimeline(value: unknown, warnings: string[]): StateTimelineDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateTimelineDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`timeline[${index}] dropped: expected object.`);
      return;
    }
    const marker = normalizeText(entry.marker) || normalizeText(entry.timeMarker);
    if (!marker) return;
    result.push({
      chapterNumber: normalizePositiveInteger(entry.chapterNumber) || undefined,
      marker,
      relativeChronology: normalizeText(entry.relativeChronology) || undefined,
      location: normalizeText(entry.location) || undefined,
      previousLocation: normalizeText(entry.previousLocation) || undefined,
      event: normalizeText(entry.event) || undefined,
      characterName: normalizeText(entry.characterName) || undefined
    });
  });
  return result;
}

function normalizeConsequences(value: unknown, type = 'consequence'): StateConsequenceDelta[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (typeof entry === 'string' && entry.trim()) return [{ type, description: entry.trim() }];
    if (!isRecord(entry)) return [];
    const description = normalizeText(entry.description) || normalizeText(entry.text);
    if (!description) return [];
    return [{
      id: normalizeText(entry.id) || undefined,
      type: normalizeText(entry.type) || type,
      description,
      status: entry.status === 'resolved' ? 'resolved' as const : 'active' as const
    }];
  });
}

const FORBIDDEN_AI_TRUTH_KEYS = new Set([
  'actualtruth', 'actualtruthhidden', 'authoronlysecret', 'authoronlysecrets',
  'canonicalfutureanswer', 'spoilertruth', 'lockedworldtruth', 'secrettruth'
]);

function collectForbiddenTruthKeys(value: unknown, path = 'delta', found: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenTruthKeys(item, `${path}[${index}]`, found));
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, item]) => {
      if (FORBIDDEN_AI_TRUTH_KEYS.has(key.toLocaleLowerCase('en-US'))) found.push(`${path}.${key}`);
      collectForbiddenTruthKeys(item, `${path}.${key}`, found);
    });
  }
  return found;
}

function normalizeSeeds(value: unknown, warnings: string[]): StateSeedDelta[] {
  if (!Array.isArray(value)) return [];
  const result: StateSeedDelta[] = [];
  value.forEach((entry, index) => {
    if (!isRecord(entry)) {
      warnings.push(`seeds[${index}] bị bỏ vì không phải object.`);
      return;
    }
    if (entry.meaningHidden !== undefined) warnings.push(`AUTHOR_TRUTH_DROPPED: seeds[${index}].meaningHidden`);
    const meaningHidden = normalizeText(entry.observableSetup) || normalizeText(entry.setup) || normalizeText(entry.description);
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
  for (const path of collectForbiddenTruthKeys(value)) {
    warnings.push(`AUTHOR_TRUTH_DROPPED: ${path}`);
  }
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
    knowledge: normalizeKnowledge(value.knowledge || value.knowledgeEntries, warnings),
    timeline: normalizeTimeline(value.timeline || value.timeMarkers || value.locationTransitions, warnings),
    consequences: [
      ...normalizeConsequences(value.consequences),
      ...normalizeConsequences(value.promises, 'promise'),
      ...normalizeConsequences(value.debts, 'debt'),
      ...normalizeConsequences(value.favors, 'favor')
    ],
    resolvedConsequenceIds: normalizeStringArray(value.resolvedConsequenceIds),
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

function normalizeExistingInjuries(value: unknown, _endChapter: number): CharacterInjury[] {
  if (!Array.isArray(value)) return [];
  const result: CharacterInjury[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const receivedChapter = normalizePositiveInteger(entry.receivedChapter);
    const expectedRecoveryChapter = normalizePositiveInteger(entry.expectedRecoveryChapter);
    if (receivedChapter === null || expectedRecoveryChapter === null) continue;
    const severities: InjurySeverity[] = ['mild', 'moderate', 'severe', 'critical'];
    result.push({
      id: normalizeText(entry.id) || undefined,
      type: normalizeText(entry.type) || 'Chấn thương',
      bodyPart: normalizeText(entry.bodyPart) || 'Cơ thể',
      severity: severities.find(item => item === entry.severity) || 'moderate',
      receivedChapter,
      expectedRecoveryChapter,
      restrictions: normalizeStringArray(entry.restrictions),
      status: entry.status === 'improving' || entry.status === 'worsening' || entry.status === 'recovered'
        || entry.status === 'permanent' ? entry.status : 'active',
      resolvedChapter: normalizePositiveInteger(entry.resolvedChapter) || undefined
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
      activeFaction: normalizeText(entry.activeFaction) || undefined,
      priorLocation: normalizeText(entry.priorLocation) || undefined,
      lastLocationChangeChapter: normalizePositiveInteger(entry.lastLocationChangeChapter) || undefined
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
    actualTruthHidden: '',
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

function normalizedIdentity(value: string): string {
  return value.toLocaleLowerCase('vi-VN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\W+/g, ' ').trim();
}

function knowledgeKey(entry: KnowledgeEntry): string {
  return [entry.factId || normalizedIdentity(entry.fact), entry.characterId || '*', entry.source, entry.learnedChapter]
    .map(value => String(value).toLocaleLowerCase('vi-VN')).join('###');
}

export function mergeKnowledgeEntries(existing: unknown, incoming: StateKnowledgeDelta[], fallbackChapter: number): KnowledgeEntry[] {
  const merged = new Map<string, KnowledgeEntry>();
  if (Array.isArray(existing)) {
    for (const value of existing) {
      if (!isRecord(value)) continue;
      const fact = normalizeText(value.fact) || normalizeText(value.interpretation);
      if (!fact) continue;
      const entry: KnowledgeEntry = {
        factId: normalizeText(value.factId) || `fact_${normalizedIdentity(fact).replace(/\s+/g, '_')}`,
        fact,
        characterId: normalizeText(value.characterId) || undefined,
        learnedChapter: normalizePositiveInteger(value.learnedChapter) || fallbackChapter,
        source: normalizeText(value.source) || 'unknown',
        confidence: normalizeBoundedNumber(value.confidence, 0, 1) ?? 0.5,
        interpretation: normalizeText(value.interpretation) || undefined,
        status: value.status === 'questioned' || value.status === 'retracted' || value.status === 'confirmed'
          ? value.status : 'believed'
      };
      merged.set(knowledgeKey(entry), entry);
    }
  }
  for (const value of incoming) {
    const entry: KnowledgeEntry = {
      factId: value.factId || `fact_${normalizedIdentity(value.fact).replace(/\s+/g, '_')}`,
      fact: value.fact,
      characterId: value.characterId,
      learnedChapter: value.learnedChapter || fallbackChapter,
      source: value.source || 'unknown',
      confidence: value.confidence,
      interpretation: value.interpretation,
      status: value.status || 'believed'
    };
    const key = knowledgeKey(entry);
    const prior = merged.get(key);
    if (!prior) merged.set(key, entry);
    else merged.set(key, {
      ...prior,
      confidence: Math.max(prior.confidence, entry.confidence),
      interpretation: entry.interpretation || prior.interpretation,
      status: entry.status || prior.status
    });
  }
  return Array.from(merged.values()).sort((a, b) => a.learnedChapter - b.learnedChapter);
}

export function mergeCumulativeContinuity(previous: string | undefined, delta: string | undefined, endChapter: number, maxLength = 6000): string {
  const oldText = normalizeText(previous) || '';
  const newText = normalizeText(delta) || '';
  if (!newText) return oldText;
  const labeled = `(Đến chương ${endChapter}): ${newText}`;
  if (!oldText) return labeled.slice(0, maxLength);
  if (normalizedIdentity(oldText).includes(normalizedIdentity(newText))) return oldText.slice(-maxLength);
  const combined = `${oldText}\n${labeled}`;
  if (combined.length <= maxLength) return combined;
  // Keep the durable older half and the newest delta. This deterministic fallback never drops all prior continuity.
  const oldBudget = Math.max(500, maxLength - labeled.length - 1);
  return `${oldText.slice(0, oldBudget)}\n${labeled}`.slice(0, maxLength);
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
  const endChapter = startChapter + acceptedChapters.length - 1;
  const currentArc = getArcForChapter(control, endChapter);
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
      if ((error as { name?: string })?.name === 'AbortError' || /abort|cancel/i.test(error instanceof Error ? error.message : String(error))) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`STATE_DELTA_INVALID: State Extractor runner lỗi: ${detail}`, { cause: error });
    }
    if (parseResult.usedFallback) {
      throw new Error(`STATE_DELTA_INVALID: ${parseResult.warnings.join(' ') || 'State Extractor không trả về JSON object hợp lệ.'}`);
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
    const injuryId = injury.injuryId || `injury_${normalizedIdentity(injury.characterName)}_${normalizedIdentity(injury.type)}_${normalizedIdentity(injury.bodyPart)}`;
    const existingInjury = nextCharacterStates[key].injuries.find(item => item.id === injuryId
      || (normalizedIdentity(item.type) === normalizedIdentity(injury.type)
        && normalizedIdentity(item.bodyPart) === normalizedIdentity(injury.bodyPart)));
    if (existingInjury) {
      if (injury.status) existingInjury.status = injury.status;
      if (injury.status === 'recovered') {
        existingInjury.resolvedChapter = endChapter;
        existingInjury.restrictions = [];
      } else {
        existingInjury.severity = injury.severity;
        if (injury.restrictions.length) existingInjury.restrictions = injury.restrictions;
      }
      continue;
    }
    nextCharacterStates[key].injuries.push({
      id: injuryId,
      type: injury.type,
      bodyPart: injury.bodyPart,
      severity: injury.severity,
      receivedChapter: startChapter,
      expectedRecoveryChapter: startChapter + injury.durationChapters,
      status: injury.status || 'active',
      resolvedChapter: injury.status === 'recovered' ? endChapter : undefined,
      restrictions: injury.restrictions.length ? injury.restrictions : ['Hạn chế vận động mạnh']
    });
  }

  const relationshipsMap = new Map<string, StoryRelationship>();
  for (const relationship of normalizeExistingRelationships(previousState.relationships)) {
    relationshipsMap.set(pairKey(relationship.characterA, relationship.characterB), relationship);
  }
  for (const relationship of delta.relationships) {
    const key = pairKey(relationship.characterA, relationship.characterB);
    const prior = relationshipsMap.get(key);
    if (!relationship.stage && prior) relationship.stage = prior.stage;
    relationshipsMap.set(key, {
      characterA: relationship.characterA,
      characterB: relationship.characterB,
      trust: relationship.trust ?? prior?.trust ?? 50,
      hostility: relationship.hostility ?? prior?.hostility ?? 10,
      stage: relationship.stage || 'Quen biết',
      debt: relationship.notes ?? prior?.debt,
      lastMajorChangeChapter: endChapter
    });
  }

  const clues = normalizeExistingClues(previousState.clues);
  for (const clue of delta.clues) {
    const existingClue = clues.find(item => normalizedIdentity(item.clue) === normalizedIdentity(clue.clue));
    if (existingClue) {
      existingClue.knownInterpretations = Array.from(new Set([...existingClue.knownInterpretations, ...clue.interpretations]));
      continue;
    }
    clues.push({
      id: `clue_${startChapter}_${clues.length + 1}`,
      clue: clue.clue,
      discoveredChapter: startChapter,
      discoveredBy: clue.discoveredBy || 'Nhân vật chính',
      knownInterpretations: clue.interpretations,
      actualTruthHidden: '',
      resolved: false
    });
  }

  const longTermSeeds = normalizeExistingSeeds(previousState.longTermSeeds);
  for (const seed of delta.seeds) {
    if (longTermSeeds.some(item => normalizedIdentity(item.meaningHidden) === normalizedIdentity(seed.meaningHidden))) continue;
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
  for (const character of Object.values(control.characterRegistry || {})) {
    if (getCharacterAccess(control, character, endChapter).canMention) unlockedCharacterIds.add(character.id);
  }

  const worldFactStates: StoryState['worldFactStates'] = {};
  if (isRecord(previousState.worldFactStates)) {
    for (const [factId, status] of Object.entries(previousState.worldFactStates)) {
      if (status === 'hidden' || status === 'foreshadowed' || status === 'revealed') worldFactStates[factId] = status;
    }
  }
  for (const fact of control.worldFacts || []) {
    if (isWorldFactAvailable(fact, endChapter)) {
      if (!worldFactStates[fact.id] || worldFactStates[fact.id] === 'hidden') worldFactStates[fact.id] = 'revealed';
    } else if (!worldFactStates[fact.id]) {
      worldFactStates[fact.id] = 'hidden';
    }
  }

  const timeline = Array.isArray(previousState.timeline)
    ? previousState.timeline.filter(item => item && typeof item.marker === 'string')
    : [];
  for (const item of delta.timeline) {
    const chapter = item.chapterNumber || endChapter;
    timeline.push({ chapter, marker: item.marker, relativeChronology: item.relativeChronology,
      location: item.location, previousLocation: item.previousLocation, event: item.event });
    if (item.characterName && item.location) {
      const character = nextCharacterStates[item.characterName.toLocaleLowerCase('vi-VN')];
      if (character && character.location !== item.location) {
        character.priorLocation = character.location || item.previousLocation;
        character.location = item.location;
        character.lastLocationChangeChapter = chapter;
      }
    }
  }
  const knowledgeLedger = mergeKnowledgeEntries(previousState.knowledgeLedger, delta.knowledge, endChapter);
  const consequences = new Map<string, StoryConsequence>();
  for (const item of previousState.consequences || []) {
    if (item?.id && item.description) consequences.set(item.id, { ...item });
  }
  for (const id of delta.resolvedConsequenceIds) {
    const prior = consequences.get(id);
    if (prior) consequences.set(id, { ...prior, status: 'resolved', resolvedChapter: endChapter });
  }
  for (const item of delta.consequences) {
    const id = item.id || `${item.type}_${normalizedIdentity(item.description).replace(/\s+/g, '_')}`;
    const prior = consequences.get(id);
    consequences.set(id, {
      id,
      type: item.type,
      description: item.description,
      createdChapter: prior?.createdChapter || endChapter,
      status: item.status || prior?.status || 'active',
      resolvedChapter: item.status === 'resolved' ? endChapter : prior?.resolvedChapter
    });
  }

  const newMemories: ChapterMemory[] = acceptedChapters.map((chapter, index) => {
    const chapterNumber = startChapter + index;
    const aiMemory = delta.chapterSummaries.find(summary => summary.chapterNumber === chapterNumber);
    const memoryText = `${aiMemory?.summary || ''} ${chapter.content}`;
    return {
      id: `memory_${chapterNumber}`,
      schemaVersion: MEMORY_SCHEMA_VERSION,
      sourceHash: control.sourceHash,
      chapterStart: chapterNumber,
      chapterEnd: chapterNumber,
      chapterNumber,
      title: normalizeText(chapter.title) || `Chương ${chapterNumber}`,
      summary: aiMemory?.summary || `${chapter.content.slice(0, 300)}...`,
      charactersInvolved: aiMemory?.charactersInvolved || [],
      locations: aiMemory?.locations || [],
      clues: aiMemory?.clues || [],
      relationshipChanges: aiMemory?.relationshipChanges || [],
      injuries: aiMemory?.injuries || [],
      resources: aiMemory?.resources || [],
      longTermSeeds: aiMemory?.longTermSeeds || [],
      arcId: getArcForChapter(control, chapterNumber).id,
      characterIds: (aiMemory?.charactersInvolved || []).map(normalizedIdentity),
      threadIds: unresolvedThreads.filter(thread => memoryText.toLocaleLowerCase('vi-VN').includes(thread.toLocaleLowerCase('vi-VN'))),
      factIds: knowledgeLedger.filter(entry => entry.learnedChapter === chapterNumber).map(entry => entry.factId),
      seedIds: longTermSeeds.filter(seed => seed.plantedChapter === chapterNumber).map(seed => seed.id),
      injuryIds: Object.values(nextCharacterStates).flatMap(character => character.injuries)
        .filter(injury => injury.receivedChapter === chapterNumber).map(injury => injury.id || injury.type),
      relationshipIds: delta.relationships.map(relationship => pairKey(relationship.characterA, relationship.characterB)),
      consequenceIds: delta.consequences.map(item => item.id || `${item.type}_${normalizedIdentity(item.description).replace(/\s+/g, '_')}`),
      importance: (aiMemory?.clues.length || aiMemory?.longTermSeeds.length || aiMemory?.injuries.length) ? 80 : 50,
      resolved: false,
      order: chapterNumber
    };
  });

  const batchSummary = delta.batchSummary || normalizeText(rawSummary)
    || acceptedChapters.map(chapter => normalizeText(chapter.title)).filter((title): title is string => title !== null).join('; ');
  const latestBatchContinuity = previousState.currentChapter === 0
    ? `Tiến trình khởi đầu (Chương 1-${endChapter}): ${batchSummary}`
    : `(Đến chương ${endChapter}): ${batchSummary}`;

  const updatedContinuitySummary = mergeCumulativeContinuity(
    previousState.continuitySummary,
    batchSummary || latestBatchContinuity,
    endChapter
  );

  const previousResources = isRecord(previousState.resources) ? previousState.resources : {};
  const resources: StoryState['resources'] = {};
  for (const [key, value] of Object.entries(previousResources)) {
    const text = normalizeText(value);
    if (text) resources[key] = text;
    else if (Array.isArray(value)) resources[key] = normalizeStringArray(value);
  }
  if (delta.resources.money) resources.money = delta.resources.money;
  if (delta.resources.businesses?.length) resources.businesses = Array.from(new Set([...(resources.businesses || []), ...delta.resources.businesses]));
  if (delta.resources.properties?.length) resources.properties = Array.from(new Set([...(resources.properties || []), ...delta.resources.properties]));
  if (delta.resources.equipment?.length) resources.equipment = Array.from(new Set([...(resources.equipment || []), ...delta.resources.equipment]));
  const recentConsequences = [
    ...normalizeStringArray(previousState.recentConsequences),
    ...delta.injuries.map(injury => `${injury.characterName} bị thương ở ${injury.bodyPart}`)
  ];
  recentConsequences.push(...delta.consequences.filter(item => item.status !== 'resolved').map(item => item.description));
  const nextState: StoryState = {
    schemaVersion: STORY_STATE_SCHEMA_VERSION,
    sourceHash: control.sourceHash,
    currentChapter: endChapter,
    characterStates: nextCharacterStates,
    relationships: Array.from(relationshipsMap.values()),
    resources,
    clues,
    unresolvedThreads,
    longTermSeeds,
    recentConsequences: Array.from(new Set(recentConsequences)).slice(-200),
    currentArcId: currentArc.id,
    currentArcProgress: arcProgress,
    unlockedCharacterIds: Array.from(unlockedCharacterIds),
    worldFactStates,
    activeFactions: normalizeStringArray(previousState.activeFactions),
    knowledgeLedger,
    timeline: timeline.slice(-200),
    continuitySummary: updatedContinuitySummary,
    consequences: Array.from(consequences.values())
  };

  return { nextState, newCharacters, updatedContinuitySummary, newMemories };
}
