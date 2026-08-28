import {
  ArcDefinition,
  AuthoritativeBlueprintV3,
  CharacterGate,
  CharacterRegistryEntry,
  JsonObject,
  JsonValue,
  NarrativeExposureRules,
  SpoilerGate,
  StoryControl,
  STORY_CONTROL_SCHEMA_VERSION,
  WorldFact
} from './types';
import {
  isRecord,
  normalizeJsonArray,
  normalizeJsonObject,
  normalizePositiveInteger,
  normalizeStringArray,
  normalizeText,
  parseJsonObject
} from './runtimeValidation';

export class BlueprintValidationError extends Error {
  constructor(message: string) {
    super(`Blueprint V3 không hợp lệ: ${message}`);
    this.name = 'BlueprintValidationError';
  }
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return normalizeJsonArray(value);
  return normalizeJsonObject(value) || undefined;
}

function normalizeArc(value: unknown, index: number): ArcDefinition {
  if (!isRecord(value)) throw new BlueprintValidationError(`arcs[${index}] phải là object.`);
  const source = normalizeJsonObject(value);
  if (!source) throw new BlueprintValidationError(`arcs[${index}] chứa dữ liệu JSON không hợp lệ.`);
  const id = normalizeText(value.id);
  const title = normalizeText(value.title);
  const startChapter = normalizePositiveInteger(value.startChapter);
  const endChapter = normalizePositiveInteger(value.endChapter);
  if (!id) throw new BlueprintValidationError(`arcs[${index}].id phải là chuỗi không rỗng.`);
  if (!title) throw new BlueprintValidationError(`arcs[${index}].title phải là chuỗi không rỗng.`);
  if (startChapter === null || endChapter === null || endChapter < startChapter) {
    throw new BlueprintValidationError(
      `arcs[${index}] có range không hợp lệ; startChapter/endChapter phải là số nguyên dương và endChapter >= startChapter.`
    );
  }
  const climaxChapter = normalizePositiveInteger(value.climaxChapter);
  if (climaxChapter !== null && (climaxChapter < startChapter || climaxChapter > endChapter)) {
    throw new BlueprintValidationError(`arcs[${index}].climaxChapter phải nằm trong range ${startChapter}-${endChapter}.`);
  }
  const pacingValues: ArcDefinition['pacing'][] = ['slow_burn', 'accelerating', 'high_stakes', 'climax', 'resolution'];
  const pacing = pacingValues.find(item => item === value.pacing) || 'accelerating';
  return {
    id,
    title,
    startChapter,
    endChapter,
    theme: normalizeText(value.theme) || '',
    coreConflict: normalizeText(value.coreConflict) || '',
    climaxChapter: climaxChapter || endChapter,
    pacing,
    unlockedCharacterIds: normalizeStringArray(value.unlockedCharacterIds),
    keyMilestones: normalizeStringArray(value.keyMilestones),
    worldBuildingFocus: normalizeText(value.worldBuildingFocus) || '',
    forbiddenSpoilers: normalizeStringArray(value.forbiddenSpoilers),
    source
  };
}

function normalizeCharacterRegistry(value: unknown, arcs: ArcDefinition[]): CharacterRegistryEntry[] {
  const candidates: { fallbackId: string; value: unknown }[] = Array.isArray(value)
    ? value.map((entry, index) => ({ fallbackId: `char_${index + 1}`, value: entry }))
    : isRecord(value)
      ? Object.entries(value).map(([key, entry]) => ({ fallbackId: key, value: entry }))
      : [];
  const result: CharacterRegistryEntry[] = [];
  const canonicalNames = new Set<string>();
  for (const candidate of candidates) {
    if (!isRecord(candidate.value)) continue;
    const name = normalizeText(candidate.value.name);
    if (!name) continue;
    const canonicalName = name.toLocaleLowerCase('vi-VN');
    if (canonicalNames.has(canonicalName)) {
      throw new BlueprintValidationError(`characterRegistry có tên canonical trùng lặp: "${name}".`);
    }
    canonicalNames.add(canonicalName);
    const source = normalizeJsonObject(candidate.value);
    if (!source) continue;
    const id = normalizeText(candidate.value.id) || candidate.fallbackId;
    const aliases = normalizeStringArray(candidate.value.aliases);
    const aliasSet = normalizeStringArray(candidate.value.aliasSet);
    const allowedArcs = normalizeStringArray(candidate.value.allowedArcs);
    const unlockChapter = normalizePositiveInteger(candidate.value.unlockChapter) || undefined;
    const rawUnlockCondition = isRecord(candidate.value.unlockCondition) ? candidate.value.unlockCondition : undefined;
    const conditionType = rawUnlockCondition?.type === 'chapter'
      || rawUnlockCondition?.type === 'clue'
      || rawUnlockCondition?.type === 'event'
      || rawUnlockCondition?.type === 'arc'
      ? rawUnlockCondition.type : undefined;
    const conditionValue = typeof rawUnlockCondition?.value === 'string' || typeof rawUnlockCondition?.value === 'number'
      ? rawUnlockCondition.value : undefined;
    result.push({
      id,
      name,
      aliasSet: aliasSet.length ? aliasSet : (aliases.length ? aliases : [name]),
      aliases: aliases.length ? aliases : aliasSet,
      role: normalizeText(candidate.value.role) || 'Nhân vật',
      gender: normalizeText(candidate.value.gender) || undefined,
      age: normalizeText(candidate.value.age) || (typeof candidate.value.age === 'number' ? String(candidate.value.age) : undefined),
      initialFaction: normalizeText(candidate.value.initialFaction) || undefined,
      appearance: normalizeText(candidate.value.appearance) || '',
      personality: normalizeText(candidate.value.personality) || '',
      coreMotivation: normalizeText(candidate.value.coreMotivation) || '',
      forbiddenSpoilers: normalizeStringArray(candidate.value.forbiddenSpoilers),
      unlockCondition: unlockChapter
        ? { type: 'chapter', value: unlockChapter }
        : conditionType && conditionValue !== undefined
          ? { type: conditionType, value: conditionValue }
          : { type: 'arc', value: normalizeText(candidate.value.unlockAtArcId) || arcs[0].id },
      allowedArcs: allowedArcs.length ? allowedArcs : arcs.map(arc => arc.id),
      deathOrExitChapter: normalizePositiveInteger(candidate.value.deathOrExitChapter) || undefined,
      relationships: normalizeJsonValue(candidate.value.relationships),
      restrictions: normalizeJsonValue(candidate.value.restrictions),
      unlockChapter,
      directAppearanceChapter: normalizePositiveInteger(candidate.value.directAppearanceChapter) || undefined,
      povUnlockChapter: normalizePositiveInteger(candidate.value.povUnlockChapter) || undefined,
      majorFocusNotBeforeChapter: normalizePositiveInteger(candidate.value.majorFocusNotBeforeChapter) || undefined,
      source
    });
  }
  return result;
}

function normalizeWorldFacts(value: unknown): WorldFact[] {
  if (!Array.isArray(value)) return [];
  const result: WorldFact[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!isRecord(entry)) continue;
    const fact = normalizeText(entry.fact) || normalizeText(entry.description) || normalizeText(entry.value);
    const source = normalizeJsonObject(entry);
    if (!fact || !source) continue;
    const visibility = entry.visibility === 'always' || entry.visibility === 'gated' || entry.visibility === 'author_only'
      ? entry.visibility : undefined;
    const scope: WorldFact['scope'] = visibility === 'author_only'
      ? 'hidden_truth'
      : visibility === 'gated' ? 'restricted' : (entry.scope === 'restricted' || entry.scope === 'hidden_truth' ? entry.scope : 'public');
    const unlockChapter = normalizePositiveInteger(entry.unlockChapter) || undefined;
    const revealChapter = normalizePositiveInteger(entry.revealChapter) || undefined;
    result.push({
      id: normalizeText(entry.id) || `world_fact_${index + 1}`,
      category: normalizeText(entry.category) || 'history',
      fact,
      scope,
      visibility,
      introducedAtChapter: normalizePositiveInteger(entry.introducedAtChapter) || unlockChapter || revealChapter || 1,
      unlockChapter,
      revealChapter,
      gateCondition: normalizeText(entry.gateCondition) || undefined,
      secretTruth: normalizeText(entry.secretTruth) || undefined,
      source
    });
  }
  return result;
}

function normalizeExposureRules(value: unknown): AuthoritativeBlueprintV3['narrativeExposureRules'] {
  if (Array.isArray(value)) {
    return value.map(normalizeJsonObject).filter((entry): entry is JsonObject => entry !== null);
  }
  if (!isRecord(value)) return [];
  const rules: NarrativeExposureRules = {
    prohibitedTopicsUntilChapter: Array.isArray(value.prohibitedTopicsUntilChapter)
      ? value.prohibitedTopicsUntilChapter.filter(isRecord).map(entry => ({
          topic: normalizeText(entry.topic) || '',
          unlockChapter: normalizePositiveInteger(entry.unlockChapter) || 1
        })).filter(entry => entry.topic)
      : [],
    foreshadowingDirectives: Array.isArray(value.foreshadowingDirectives)
      ? value.foreshadowingDirectives.filter(isRecord).map(entry => ({
          hint: normalizeText(entry.hint) || '',
          plantArcId: normalizeText(entry.plantArcId) || '',
          payoffArcId: normalizeText(entry.payoffArcId) || ''
        })).filter(entry => entry.hint)
      : [],
    mandatoryKnowledgeByChapter: Array.isArray(value.mandatoryKnowledgeByChapter)
      ? value.mandatoryKnowledgeByChapter.filter(isRecord).map(entry => ({
          chapter: normalizePositiveInteger(entry.chapter) || 1,
          requiredFactIds: normalizeStringArray(entry.requiredFactIds)
        }))
      : []
  };
  return rules;
}

function normalizeSpoilerGates(value: unknown): SpoilerGate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((gate, index) => ({
    id: normalizeText(gate.id) || `spoiler_${index + 1}`,
    description: normalizeText(gate.description) || '',
    forbiddenBeforeChapter: normalizePositiveInteger(gate.forbiddenBeforeChapter) || 1,
    permittedArcs: normalizeStringArray(gate.permittedArcs),
    relatedCharacters: normalizeStringArray(gate.relatedCharacters)
  })).filter(gate => gate.description);
}

function normalizeCharacterGates(value: unknown, arcs: ArcDefinition[]): CharacterGate[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((gate, index) => ({
    characterId: normalizeText(gate.characterId) || `char_${index + 1}`,
    characterName: normalizeText(gate.characterName) || '',
    unlockAtArcId: normalizeText(gate.unlockAtArcId) || arcs[0].id,
    unlockAtChapter: normalizePositiveInteger(gate.unlockAtChapter) || 1,
    prerequisiteClues: normalizeStringArray(gate.prerequisiteClues),
    reason: normalizeText(gate.reason) || ''
  })).filter(gate => gate.characterName);
}

export function validateBlueprintV3Object(parsed: unknown): AuthoritativeBlueprintV3 {
  if (!isRecord(parsed)) throw new BlueprintValidationError('root phải là JSON object.');
  const source = normalizeJsonObject(parsed);
  if (!source) throw new BlueprintValidationError('root chứa giá trị không phải JSON hợp lệ.');
  if (!Array.isArray(parsed.arcs) || parsed.arcs.length === 0) {
    throw new BlueprintValidationError('arcs phải là array không rỗng.');
  }
  const arcs = parsed.arcs.map(normalizeArc);
  const arcIds = new Set<string>();
  for (let index = 0; index < arcs.length; index++) {
    const arc = arcs[index];
    if (arcIds.has(arc.id)) throw new BlueprintValidationError(`arc id trùng lặp: "${arc.id}".`);
    if (index > 0 && arc.startChapter <= arcs[index - 1].endChapter) {
      throw new BlueprintValidationError(
        `arcs[${index}] chồng lấn hoặc sai thứ tự với arcs[${index - 1}] (${arc.startChapter} <= ${arcs[index - 1].endChapter}).`
      );
    }
    arcIds.add(arc.id);
  }
  if (parsed.characterRegistry !== undefined && !Array.isArray(parsed.characterRegistry) && !isRecord(parsed.characterRegistry)) {
    throw new BlueprintValidationError('characterRegistry phải là array hoặc object map.');
  }
  if (parsed.worldFacts !== undefined && !Array.isArray(parsed.worldFacts)) {
    throw new BlueprintValidationError('worldFacts phải là array.');
  }
  if (parsed.narrativeExposureRules !== undefined
    && !Array.isArray(parsed.narrativeExposureRules)
    && !isRecord(parsed.narrativeExposureRules)) {
    throw new BlueprintValidationError('narrativeExposureRules phải là array hoặc object legacy hợp lệ.');
  }
  for (const field of ['mysteryThreads', 'characterGates', 'spoilerGates', 'authorOnlySecrets']) {
    if (parsed[field] !== undefined && !Array.isArray(parsed[field])) {
      throw new BlueprintValidationError(`${field} phải là array.`);
    }
  }
  return {
    schemaVersion: typeof parsed.schemaVersion === 'string' || typeof parsed.schemaVersion === 'number'
      ? parsed.schemaVersion : undefined,
    totalChapters: normalizePositiveInteger(parsed.totalChapters) || undefined,
    settings: normalizeJsonObject(parsed.settings) || undefined,
    characterRegistry: normalizeCharacterRegistry(parsed.characterRegistry, arcs),
    worldFacts: normalizeWorldFacts(parsed.worldFacts),
    arcs,
    narrativeExposureRules: normalizeExposureRules(parsed.narrativeExposureRules),
    mysteryThreads: normalizeJsonArray(parsed.mysteryThreads),
    characterGates: normalizeCharacterGates(parsed.characterGates, arcs),
    spoilerGates: normalizeSpoilerGates(parsed.spoilerGates),
    originality: normalizeJsonValue(parsed.originality),
    authorOnlySecrets: normalizeJsonArray(parsed.authorOnlySecrets),
    source
  };
}

export function createStoryControlFromBlueprint(
  blueprint: AuthoritativeBlueprintV3,
  sourceHash = 'custom_unhashed',
  importedSettings?: JsonObject
): StoryControl {
  const characterRegistry = Object.fromEntries(blueprint.characterRegistry.map(character => [character.id, character]));
  const derivedCharacterGates: CharacterGate[] = blueprint.characterRegistry
    .filter(character => typeof character.unlockChapter === 'number' && character.unlockChapter > 1)
    .map(character => ({
      characterId: character.id,
      characterName: character.name,
      unlockAtArcId: blueprint.arcs.find(arc => character.unlockChapter && arc.startChapter <= character.unlockChapter && arc.endChapter >= character.unlockChapter)?.id || blueprint.arcs[0].id,
      unlockAtChapter: character.unlockChapter || 1,
      prerequisiteClues: [],
      reason: `Imported Blueprint V3 unlockChapter=${character.unlockChapter}.`
    }));
  const characterGates = blueprint.characterGates.length ? blueprint.characterGates : derivedCharacterGates;
  return {
    version: 'v3',
    schemaVersion: STORY_CONTROL_SCHEMA_VERSION,
    sourceHash,
    totalChapters: blueprint.totalChapters
      || normalizePositiveInteger(blueprint.settings?.totalChapters)
      || blueprint.arcs.reduce((max, arc) => Math.max(max, arc.endChapter), 1),
    arcs: blueprint.arcs,
    characterRegistry,
    worldFacts: blueprint.worldFacts,
    narrativeExposureRules: blueprint.narrativeExposureRules,
    characterGates,
    spoilerGates: blueprint.spoilerGates,
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
    settings: importedSettings || blueprint.settings,
    mysteryThreads: blueprint.mysteryThreads,
    originality: blueprint.originality,
    authorOnlySecrets: blueprint.authorOnlySecrets,
    authoritativeBlueprint: blueprint
  };
}

export function parseBlueprintContent(rawContent: string): StoryControl | null {
  if (!rawContent || !rawContent.trim()) return null;
  const match = rawContent.match(
    /\[(?:STORY_ENGINE_BLUEPRINT_V3|BLUEPRINT_V3)\]\s*\r?\n([\s\S]*?)(?=\r?\n\[[^\]]+\]|$)/i
  );
  const block = match?.[1]?.trim();
  const trimmed = rawContent.trim();
  if (!block && !(trimmed.startsWith('{') && trimmed.endsWith('}'))) return null;
  let parsed: JsonObject;
  try {
    parsed = parseJsonObject(block || trimmed, 'Blueprint V3');
  } catch (error) {
    throw new BlueprintValidationError(error instanceof Error ? error.message : String(error));
  }
  if (!Array.isArray(parsed.arcs)) {
    if (block) throw new BlueprintValidationError('thiếu arcs trong block blueprint explicit.');
    return null;
  }
  return createStoryControlFromBlueprint(validateBlueprintV3Object(parsed));
}
