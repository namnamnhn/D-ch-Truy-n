import {
  ArcDefinition,
  CharacterAccess,
  CharacterRegistryEntry,
  ExposureProjection,
  MysteryStage,
  NarrativeExposureRule,
  NarrativeExposureRules,
  StoryControl,
  StoryEngineSanityInfo,
  WorldFact
} from './types';
import { isRecord, normalizeJsonObject, normalizePositiveInteger, normalizeStringArray, normalizeText } from './runtimeValidation';

const unique = (values: string[]): string[] => Array.from(new Set(values.filter(Boolean)));

export function normalizeReference(value: string): string {
  return value.trim().toLocaleLowerCase('vi-VN');
}

export function getArcForChapter(control: StoryControl, chapter: number): ArcDefinition {
  if (!Number.isInteger(chapter) || chapter < 1) {
    throw new Error(`Không thể xác định Arc: chapter phải là số nguyên dương, nhận ${chapter}.`);
  }
  const matches = (control.arcs || []).filter(arc => chapter >= arc.startChapter && chapter <= arc.endChapter);
  if (matches.length === 0) {
    const ranges = (control.arcs || []).map(arc => `${arc.id}:${arc.startChapter}-${arc.endChapter}`).join(', ');
    throw new Error(`Không có Arc authoritative bao phủ Chương ${chapter}. Các range hiện có: ${ranges || '(không có)'}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Blueprint có Arc chồng lấn tại Chương ${chapter}: ${matches.map(arc => arc.id).join(', ')}.`);
  }
  return matches[0];
}

export function validateArcRanges(control: StoryControl): void {
  const sorted = [...(control.arcs || [])].sort((a, b) => a.startChapter - b.startChapter || a.endChapter - b.endChapter);
  if (sorted.length === 0) throw new Error('StoryControl không có Arc authoritative nào.');
  for (let index = 0; index < sorted.length; index++) {
    const arc = sorted[index];
    if (arc.startChapter < 1 || arc.endChapter < arc.startChapter) {
      throw new Error(`Arc ${arc.id} có range không hợp lệ ${arc.startChapter}-${arc.endChapter}.`);
    }
    const previous = sorted[index - 1];
    if (previous && arc.startChapter <= previous.endChapter) {
      throw new Error(`Blueprint có Arc chồng lấn: ${previous.id} (${previous.startChapter}-${previous.endChapter}) và ${arc.id} (${arc.startChapter}-${arc.endChapter}).`);
    }
  }
}

export interface ArcSegment {
  arc: ArcDefinition;
  chapterNumbers: number[];
}

export function splitChaptersByArc(control: StoryControl, chapterNumbers: number[]): ArcSegment[] {
  const segments: ArcSegment[] = [];
  for (const chapter of chapterNumbers) {
    const arc = getArcForChapter(control, chapter);
    const last = segments[segments.length - 1];
    if (last?.arc.id === arc.id) last.chapterNumbers.push(chapter);
    else segments.push({ arc, chapterNumbers: [chapter] });
  }
  return segments;
}

function getCharacterGateChapter(control: StoryControl, character: CharacterRegistryEntry): number {
  const gate = (control.characterGates || []).find(candidate =>
    candidate.characterId === character.id
    || normalizeReference(candidate.characterName) === normalizeReference(character.name)
  );
  if (character.unlockChapter) return character.unlockChapter;
  if (character.unlockCondition?.type === 'chapter' && typeof character.unlockCondition.value === 'number') {
    return character.unlockCondition.value;
  }
  if (gate?.unlockAtChapter) return gate.unlockAtChapter;
  if (character.unlockCondition?.type === 'arc' && typeof character.unlockCondition.value === 'string') {
    const arc = control.arcs.find(candidate => candidate.id === character.unlockCondition.value);
    if (arc) return arc.startChapter;
  }
  return 1;
}

export function getCharacterAccess(
  control: StoryControl,
  character: CharacterRegistryEntry,
  chapter: number
): CharacterAccess {
  const unlockChapter = getCharacterGateChapter(control, character);
  const directAppearanceChapter = character.directAppearanceChapter ?? unlockChapter;
  const povUnlockChapter = character.povUnlockChapter ?? directAppearanceChapter;
  const majorFocusNotBeforeChapter = character.majorFocusNotBeforeChapter ?? directAppearanceChapter;
  const canMention = chapter >= unlockChapter;
  const canAppearDirectly = canMention && chapter >= directAppearanceChapter;
  const canUsePov = canAppearDirectly && chapter >= povUnlockChapter;
  const canTakeMajorFocus = canAppearDirectly && chapter >= majorFocusNotBeforeChapter;
  let level: CharacterAccess['level'] = 'LOCKED';
  if (canMention) level = 'MENTION_ONLY';
  if (canAppearDirectly) level = 'DIRECT_ALLOWED';
  if (canUsePov) level = 'POV_ALLOWED';
  if (canUsePov && canTakeMajorFocus) level = 'MAJOR_FOCUS_ALLOWED';
  return {
    level,
    canMention,
    canAppearDirectly,
    canUsePov,
    canTakeMajorFocus,
    unlockChapter,
    directAppearanceChapter,
    povUnlockChapter,
    majorFocusNotBeforeChapter
  };
}

export interface ProjectedCharacter {
  id: string;
  name: string;
  aliases?: string[];
  access: CharacterAccess['level'];
  role?: string;
  gender?: string;
  age?: string;
  appearance?: string;
  personality?: string;
  restrictions: string[];
}

export function projectCharactersForChapter(control: StoryControl, chapter: number): {
  available: ProjectedCharacter[];
  lockedCount: number;
} {
  const available: ProjectedCharacter[] = [];
  let lockedCount = 0;
  for (const character of Object.values(control.characterRegistry || {})) {
    const access = getCharacterAccess(control, character, chapter);
    if (!access.canMention) {
      lockedCount++;
      continue;
    }
    const minimal: ProjectedCharacter = {
      id: character.id,
      name: character.name,
      access: access.level,
      restrictions: []
    };
    available.push(access.canAppearDirectly ? {
      ...minimal,
      aliases: unique([...(character.aliases || []), ...(character.aliasSet || [])]),
      role: character.role,
      gender: character.gender,
      age: character.age,
      appearance: character.appearance,
      personality: character.personality,
      restrictions: character.restrictions || []
    } : minimal);
  }
  return { available, lockedCount };
}

export function findCharacter(control: StoryControl, reference: string): CharacterRegistryEntry | undefined {
  const normalized = normalizeReference(reference);
  return Object.values(control.characterRegistry || {}).find(character =>
    normalizeReference(character.id) === normalized
    || normalizeReference(character.name) === normalized
    || [...(character.aliases || []), ...(character.aliasSet || [])].some(alias => normalizeReference(alias) === normalized)
  );
}

export function getWorldFactGateChapter(fact: WorldFact): number {
  return fact.unlockChapter ?? fact.revealChapter ?? fact.introducedAtChapter ?? 1;
}

export function isWorldFactAvailable(fact: WorldFact, chapter: number): boolean {
  if (fact.visibility === 'author_only' || fact.scope === 'hidden_truth') return false;
  return chapter >= getWorldFactGateChapter(fact);
}

export function projectWorldFactsForChapter(control: StoryControl, chapter: number): {
  available: WorldFact[];
  locked: WorldFact[];
} {
  const available: WorldFact[] = [];
  const locked: WorldFact[] = [];
  for (const fact of control.worldFacts || []) {
    if (isWorldFactAvailable(fact, chapter)) {
      const { secretTruth: _secretTruth, source: _source, ...readerSafeFact } = fact;
      available.push(readerSafeFact as WorldFact);
    } else {
      locked.push(fact);
    }
  }
  return { available, locked };
}

function legacyExposureRules(control: StoryControl, legacy: NarrativeExposureRules): NarrativeExposureRule[] {
  const rules: NarrativeExposureRule[] = [];
  legacy.prohibitedTopicsUntilChapter.forEach((entry, index) => {
    if (entry.unlockChapter <= 1) return;
    rules.push({
      id: `legacy_prohibited_${index + 1}`,
      startChapter: 1,
      endChapter: entry.unlockChapter - 1,
      allowedEvidence: [],
      forbiddenEvidence: [entry.topic],
      allowedInferences: [],
      forbiddenInferences: [entry.topic],
      readerKnowledgeCeiling: `Không được xác nhận hoặc suy ra: ${entry.topic}`,
      relatedWorldFactIds: []
    });
  });
  legacy.foreshadowingDirectives.forEach((entry, index) => {
    const arc = control.arcs.find(candidate => candidate.id === entry.plantArcId);
    if (!arc) return;
    rules.push({
      id: `legacy_foreshadow_${index + 1}`,
      startChapter: arc.startChapter,
      endChapter: arc.endChapter,
      allowedEvidence: [entry.hint],
      forbiddenEvidence: [],
      allowedInferences: [],
      forbiddenInferences: [],
      readerKnowledgeCeiling: `Chỉ được gieo gợi ý trong ${entry.plantArcId}; payoff thuộc ${entry.payoffArcId}.`,
      relatedWorldFactIds: []
    });
  });
  return rules;
}

export function getAllExposureRules(control: StoryControl): NarrativeExposureRule[] {
  const value = control.narrativeExposureRules;
  if (Array.isArray(value)) return value.filter(isRecord).map((entry, index) => {
    const legacyUnlock = normalizePositiveInteger(entry.unlockChapter);
    const legacyTopic = legacyUnlock === 1 ? null : normalizeText(entry.topic);
    const startChapter = normalizePositiveInteger(entry.startChapter) || 1;
    const endChapter = normalizePositiveInteger(entry.endChapter)
      || (legacyTopic && legacyUnlock ? legacyUnlock - 1 : Number.MAX_SAFE_INTEGER);
    if (endChapter < startChapter) {
      throw new Error(`Exposure rule ${normalizeText(entry.id) || index + 1} có endChapter < startChapter.`);
    }
    return {
      id: normalizeText(entry.id) || `exposure_${index + 1}`,
      threadId: normalizeText(entry.threadId) || undefined,
      startChapter,
      endChapter,
      allowedEvidence: normalizeStringArray(entry.allowedEvidence),
      forbiddenEvidence: normalizeStringArray(entry.forbiddenEvidence).length
        ? normalizeStringArray(entry.forbiddenEvidence) : legacyTopic ? [legacyTopic] : [],
      allowedInferences: normalizeStringArray(entry.allowedInferences),
      forbiddenInferences: normalizeStringArray(entry.forbiddenInferences).length
        ? normalizeStringArray(entry.forbiddenInferences) : legacyTopic ? [legacyTopic] : [],
      readerKnowledgeCeiling: normalizeText(entry.readerKnowledgeCeiling)
        || (legacyTopic ? `Không được xác nhận hoặc suy ra: ${legacyTopic}` : ''),
      relatedWorldFactIds: normalizeStringArray(entry.relatedWorldFactIds),
      source: normalizeJsonObject(entry) || undefined
    };
  });
  return legacyExposureRules(control, value);
}

export function getActiveExposureRules(control: StoryControl, chapter: number): NarrativeExposureRule[] {
  return getAllExposureRules(control).filter(rule => chapter >= rule.startChapter && chapter <= rule.endChapter);
}

export function projectExposureRules(control: StoryControl, chapter: number, includeForbidden: boolean): ExposureProjection {
  const rules = getActiveExposureRules(control, chapter);
  const availableFactIds = new Set(projectWorldFactsForChapter(control, chapter).available.map(fact => fact.id));
  return {
    ruleIds: rules.map(rule => rule.id),
    allowedEvidence: unique(rules.flatMap(rule => rule.allowedEvidence)),
    forbiddenEvidence: includeForbidden ? unique(rules.flatMap(rule => rule.forbiddenEvidence)) : [],
    allowedInferences: unique(rules.flatMap(rule => rule.allowedInferences)),
    forbiddenInferences: includeForbidden ? unique(rules.flatMap(rule => rule.forbiddenInferences)) : [],
    readerKnowledgeCeilings: unique(rules.map(rule => rule.readerKnowledgeCeiling)),
    relatedWorldFactIds: unique(rules.flatMap(rule => rule.relatedWorldFactIds))
      .filter(id => includeForbidden || availableFactIds.has(id))
  };
}

export function getActiveMysteryStages(control: StoryControl, chapter: number): Array<{ threadId: string; stage: MysteryStage }> {
  return (control.mysteryThreads || []).flatMap((rawThread, threadIndex) => {
    if (!isRecord(rawThread)) return [];
    const thread = rawThread;
    const threadId = normalizeText(thread.id) || `mystery_${threadIndex + 1}`;
    if (!Array.isArray(thread.stages)) return [];
    return thread.stages.flatMap((rawStage, stageIndex): MysteryStage[] => {
      if (!isRecord(rawStage)) return [];
      const stage = rawStage;
      return [{
        id: normalizeText(stage.id) || `${threadId}_stage_${stageIndex + 1}`,
        startChapter: normalizePositiveInteger(stage.startChapter) || normalizePositiveInteger(stage.unlockChapter) || 1,
        endChapter: normalizePositiveInteger(stage.endChapter) || normalizePositiveInteger(stage.untilChapter) || Number.MAX_SAFE_INTEGER,
        allowedKnowledge: normalizeStringArray(stage.allowedKnowledge).length
          ? normalizeStringArray(stage.allowedKnowledge) : normalizeStringArray(stage.readerKnowledge),
        allowedEvidence: normalizeStringArray(stage.allowedEvidence),
        allowedInferences: normalizeStringArray(stage.allowedInferences),
        readerKnowledgeCeiling: normalizeText(stage.readerKnowledgeCeiling) || undefined,
        source: normalizeJsonObject(stage) || undefined
      }];
    }).filter(stage => chapter >= stage.startChapter && chapter <= stage.endChapter)
      .map(stage => ({ threadId, stage }));
  });
}

export function getStoryEngineSanityInfo(control: StoryControl, chapter: number): StoryEngineSanityInfo {
  const arc = getArcForChapter(control, chapter);
  const characters = projectCharactersForChapter(control, chapter);
  const facts = projectWorldFactsForChapter(control, chapter);
  return {
    chapter,
    arcId: arc.id,
    activeCharacterCount: characters.available.length,
    lockedCharacterCount: characters.lockedCount,
    activeWorldFacts: facts.available.map(fact => fact.id),
    lockedWorldFacts: facts.locked.map(fact => fact.id),
    activeExposureRuleIds: getActiveExposureRules(control, chapter).map(rule => rule.id),
    mysteryStageIds: getActiveMysteryStages(control, chapter).map(item => item.stage.id)
  };
}
