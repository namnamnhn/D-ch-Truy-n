import { Character, CreativeChapter, CreativeState } from '../../types';
import {
  AuthoritativeBlueprintV3,
  ChapterMemory,
  CharacterInjury,
  CharacterState,
  LongTermSeed,
  StoryClue,
  JsonObject,
  StoryRelationship,
  StoryControl,
  StoryState,
  ValidationResult,
  Violation,
  ViolationType,
  STORY_VIOLATION_TYPES,
  STORY_STATE_SCHEMA_VERSION,
  MEMORY_SCHEMA_VERSION
} from './types';
import { createStoryControlFromBlueprint, validateBlueprintV3Object } from './blueprintParser';
import {
  isRecord,
  normalizeJsonObject,
  normalizePositiveInteger,
  normalizeStringArray,
  normalizeText,
  parseJsonObject
} from './runtimeValidation';

export type SetupImportKind = 'AUTHOR_SETUP' | 'FULL_PROJECT';

export interface ParsedSetupFile {
  importKind: SetupImportKind;
  seedTitle: string;
  genre: string;
  premise: string;
  worldNotes: string;
  charNotes: string;
  outline: string;
  characters: Character[];
  seriesPremise?: string;
  continuitySummary?: string;
  storyEngineSettingsV3?: JsonObject;
  blueprintV3?: AuthoritativeBlueprintV3;
  storyControl?: StoryControl;
  storyState?: StoryState;
  memoryIndex?: ChapterMemory[];
  chapters?: CreativeChapter[];
  lastValidationResult?: ValidationResult;
}

const PLACEHOLDER_VALUES = new Set(['(Chưa chọn)', '(Chưa có)', '(Chưa có nhân vật nào)', '(Chưa đặt tên)']);

function getSection(text: string, label: string): string {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = text.match(new RegExp(`\\[${escaped}\\]\\s*\\r?\\n([\\s\\S]*?)(?=\\r?\\n\\[[^\\]]+\\]|$)`, 'i'));
  const value = match?.[1]?.trim() || '';
  return PLACEHOLDER_VALUES.has(value) ? '' : value;
}

function makeCharacterId(name: string, index: number): string {
  const slug = name.toLocaleLowerCase('vi-VN')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `char_${slug || index + 1}`;
}

function parseCharacterBlock(block: string, index: number): Character | null {
  const lines = block.split(/\r?\n/);
  const header = normalizeText(lines[0]) || '';
  const match = header.match(/^-\s*([^(,]+?)\s*(?:\(([^)]*)\))?\s*(?:,\s*(.+))?$/);
  if (!match || !normalizeText(match[1])) return null;
  const name = normalizeText(match[1]) || '';
  const details = [match[2], match[3]].filter((value): value is string => typeof value === 'string')
    .flatMap(value => value.split(',').map(part => part.trim()).filter(Boolean));
  let role = '';
  let gender = '';
  let age = '';
  for (const detail of details) {
    const ageMatch = detail.match(/^(\d+)\s*tuổi$/i);
    if (ageMatch) age = ageMatch[1];
    else if (!role) role = detail;
    else if (!gender) gender = detail;
  }
  let appearance = '';
  let personality = '';
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (/^Ngoại hình:/i.test(trimmed)) appearance = trimmed.replace(/^Ngoại hình:/i, '').trim();
    if (/^Tính cách:/i.test(trimmed)) personality = trimmed.replace(/^Tính cách:/i, '').trim();
  }
  return {
    id: makeCharacterId(name, index),
    name,
    role,
    gender,
    age,
    appearance: PLACEHOLDER_VALUES.has(appearance) ? '' : appearance,
    personality: PLACEHOLDER_VALUES.has(personality) ? '' : personality
  };
}

function normalizeCharacters(value: unknown): Character[] {
  if (!Array.isArray(value)) return [];
  const result: Character[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const entry = value[index];
    if (!isRecord(entry)) continue;
    const name = normalizeText(entry.name);
    if (!name) continue;
    const canonical = name.toLocaleLowerCase('vi-VN');
    if (names.has(canonical)) continue;
    names.add(canonical);
    result.push({
      id: normalizeText(entry.id) || makeCharacterId(name, index),
      name,
      gender: normalizeText(entry.gender) || '',
      age: normalizeText(entry.age) || (typeof entry.age === 'number' && Number.isFinite(entry.age) ? String(entry.age) : ''),
      role: normalizeText(entry.role) || '',
      appearance: normalizeText(entry.appearance) || '',
      personality: normalizeText(entry.personality) || ''
    });
  }
  return result;
}

function normalizeChapters(value: unknown): CreativeChapter[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const chapters: CreativeChapter[] = value.filter(isRecord).map((entry, index) => {
    const status: CreativeChapter['status'] = entry.status === 'failed' || entry.status === 'retrying'
      ? entry.status : 'completed';
    return {
      id: normalizeText(entry.id) || `chapter_${index + 1}`,
      chapterNumber: normalizePositiveInteger(entry.chapterNumber) || undefined,
      title: normalizeText(entry.title) || `Chương ${index + 1}`,
      content: normalizeText(entry.content) || '',
      status,
      retryCount: typeof entry.retryCount === 'number' && Number.isFinite(entry.retryCount) ? entry.retryCount : undefined
    };
  });
  return chapters;
}

function normalizeMemoryIndex(value: unknown, sourceHash?: string): ChapterMemory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  if (!sourceHash) return undefined;
  return value.filter(isRecord).filter(entry =>
    (entry.schemaVersion === undefined || entry.schemaVersion === MEMORY_SCHEMA_VERSION)
    && (entry.sourceHash === undefined || entry.sourceHash === sourceHash)).map(entry => ({
    id: normalizeText(entry.id) || `memory_${normalizePositiveInteger(entry.chapterNumber) || 1}`,
    schemaVersion: MEMORY_SCHEMA_VERSION,
    sourceHash,
    chapterStart: normalizePositiveInteger(entry.chapterStart) || normalizePositiveInteger(entry.chapterNumber) || 1,
    chapterEnd: normalizePositiveInteger(entry.chapterEnd) || normalizePositiveInteger(entry.chapterNumber) || 1,
    chapterNumber: normalizePositiveInteger(entry.chapterNumber) || 1,
    title: normalizeText(entry.title) || '',
    summary: normalizeText(entry.summary) || '',
    charactersInvolved: normalizeStringArray(entry.charactersInvolved),
    locations: normalizeStringArray(entry.locations),
    clues: normalizeStringArray(entry.clues),
    relationshipChanges: normalizeStringArray(entry.relationshipChanges),
    injuries: normalizeStringArray(entry.injuries),
    resources: normalizeStringArray(entry.resources),
    longTermSeeds: normalizeStringArray(entry.longTermSeeds),
    arcId: normalizeText(entry.arcId) || undefined,
    characterIds: normalizeStringArray(entry.characterIds),
    threadIds: normalizeStringArray(entry.threadIds),
    factIds: normalizeStringArray(entry.factIds),
    seedIds: normalizeStringArray(entry.seedIds),
    injuryIds: normalizeStringArray(entry.injuryIds),
    relationshipIds: normalizeStringArray(entry.relationshipIds),
    consequenceIds: normalizeStringArray(entry.consequenceIds),
    importance: typeof entry.importance === 'number' && Number.isFinite(entry.importance) ? entry.importance : 50,
    resolved: entry.resolved === true,
    irreversible: entry.irreversible === true,
    order: normalizePositiveInteger(entry.order) || normalizePositiveInteger(entry.chapterNumber) || 1
  }));
}

function normalizeImportedCharacterStates(value: unknown): Record<string, CharacterState> {
  if (!isRecord(value)) return {};
  const states: Record<string, CharacterState> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isRecord(entry)) continue;
    const name = normalizeText(entry.name) || normalizeText(key);
    if (!name) continue;
    const injuries: CharacterInjury[] = Array.isArray(entry.injuries) ? entry.injuries.filter(isRecord).map(injury => {
      const severity: CharacterInjury['severity'] = injury.severity === 'mild'
        || injury.severity === 'severe'
        || injury.severity === 'critical'
        ? injury.severity : 'moderate';
      return {
        type: normalizeText(injury.type) || 'Chấn thương',
        bodyPart: normalizeText(injury.bodyPart) || 'Cơ thể',
        severity,
        receivedChapter: normalizePositiveInteger(injury.receivedChapter) || 1,
        expectedRecoveryChapter: normalizePositiveInteger(injury.expectedRecoveryChapter) || 1,
        restrictions: normalizeStringArray(injury.restrictions),
        status: injury.status === 'improving' || injury.status === 'worsening' || injury.status === 'recovered'
          || injury.status === 'permanent' ? injury.status : 'active',
        id: normalizeText(injury.id) || undefined,
        resolvedChapter: normalizePositiveInteger(injury.resolvedChapter) || undefined
      };
    }) : [];
    states[key] = {
      characterId: normalizeText(entry.characterId) || key,
      name,
      location: normalizeText(entry.location) || '',
      physicalCondition: normalizeText(entry.physicalCondition) || '',
      injuries,
      knownFacts: normalizeStringArray(entry.knownFacts),
      goals: normalizeStringArray(entry.goals),
      activeFaction: normalizeText(entry.activeFaction) || undefined
    };
  }
  return states;
}

function normalizeImportedRelationships(value: unknown): StoryRelationship[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map(entry => ({
    characterA: normalizeText(entry.characterA) || '',
    characterB: normalizeText(entry.characterB) || '',
    trust: typeof entry.trust === 'number' && Number.isFinite(entry.trust) ? entry.trust : 50,
    hostility: typeof entry.hostility === 'number' && Number.isFinite(entry.hostility) ? entry.hostility : 10,
    stage: normalizeText(entry.stage) || '',
    debt: normalizeText(entry.debt) || undefined,
    lastMajorChangeChapter: normalizePositiveInteger(entry.lastMajorChangeChapter) || 1
  })).filter(relationship => relationship.characterA && relationship.characterB);
}

function normalizeImportedClues(value: unknown): StoryClue[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry, index) => ({
    id: normalizeText(entry.id) || `clue_${index + 1}`,
    clue: normalizeText(entry.clue) || '',
    discoveredChapter: normalizePositiveInteger(entry.discoveredChapter) || 1,
    discoveredBy: normalizeText(entry.discoveredBy) || '',
    knownInterpretations: normalizeStringArray(entry.knownInterpretations),
    actualTruthHidden: '',
    resolved: entry.resolved === true
  })).filter(clue => clue.clue);
}

function normalizeImportedSeeds(value: unknown): LongTermSeed[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((entry, index) => {
    const status: LongTermSeed['status'] = entry.status === 'foreshadowed' || entry.status === 'resolved'
      ? entry.status : 'planted';
    return {
      id: normalizeText(entry.id) || `seed_${index + 1}`,
      plantedChapter: normalizePositiveInteger(entry.plantedChapter) || 1,
      meaningHidden: normalizeText(entry.meaningHidden) || '',
      eligibleCallbackFromChapter: normalizePositiveInteger(entry.eligibleCallbackFromChapter) || 1,
      status
    };
  }).filter(seed => seed.meaningHidden);
}

function normalizeStoryState(value: unknown, sourceHash?: string): StoryState | undefined {
  if (!isRecord(value)) return undefined;
  if (!sourceHash) return undefined;
  if (value.schemaVersion !== undefined && value.schemaVersion !== STORY_STATE_SCHEMA_VERSION) return undefined;
  if (value.sourceHash !== undefined && value.sourceHash !== sourceHash) return undefined;
  const currentChapter = typeof value.currentChapter === 'number' && Number.isInteger(value.currentChapter) && value.currentChapter >= 0
    ? value.currentChapter : 0;
  return {
    schemaVersion: STORY_STATE_SCHEMA_VERSION,
    sourceHash,
    currentChapter,
    characterStates: normalizeImportedCharacterStates(value.characterStates),
    relationships: normalizeImportedRelationships(value.relationships),
    resources: isRecord(value.resources) ? {
      money: normalizeText(value.resources.money) || undefined,
      businesses: normalizeStringArray(value.resources.businesses),
      properties: normalizeStringArray(value.resources.properties),
      equipment: normalizeStringArray(value.resources.equipment)
    } : {},
    clues: normalizeImportedClues(value.clues),
    unresolvedThreads: normalizeStringArray(value.unresolvedThreads),
    longTermSeeds: normalizeImportedSeeds(value.longTermSeeds),
    recentConsequences: normalizeStringArray(value.recentConsequences),
    currentArcId: normalizeText(value.currentArcId) || '',
    currentArcProgress: typeof value.currentArcProgress === 'number' && Number.isFinite(value.currentArcProgress) ? value.currentArcProgress : 0,
    unlockedCharacterIds: normalizeStringArray(value.unlockedCharacterIds),
    worldFactStates: isRecord(value.worldFactStates)
      ? Object.fromEntries(Object.entries(value.worldFactStates).filter((entry): entry is [string, 'hidden' | 'foreshadowed' | 'revealed'] =>
          entry[1] === 'hidden' || entry[1] === 'foreshadowed' || entry[1] === 'revealed'))
      : {},
    activeFactions: normalizeStringArray(value.activeFactions),
    knowledgeLedger: Array.isArray(value.knowledgeLedger) ? value.knowledgeLedger.filter(isRecord).map(entry => ({
      factId: normalizeText(entry.factId) || '',
      fact: normalizeText(entry.fact) || normalizeText(entry.interpretation) || '',
      characterId: normalizeText(entry.characterId) || undefined,
      learnedChapter: normalizePositiveInteger(entry.learnedChapter) || currentChapter || 1,
      source: normalizeText(entry.source) || 'unknown',
      confidence: typeof entry.confidence === 'number' && Number.isFinite(entry.confidence)
        ? Math.max(0, Math.min(1, entry.confidence)) : 0.5,
      interpretation: normalizeText(entry.interpretation) || undefined,
      status: (entry.status === 'questioned' || entry.status === 'retracted' || entry.status === 'confirmed'
        ? entry.status : 'believed') as 'believed' | 'questioned' | 'retracted' | 'confirmed'
    })).filter(entry => entry.factId && entry.fact) : [],
    timeline: Array.isArray(value.timeline) ? value.timeline.filter(isRecord).map(entry => ({
      chapter: normalizePositiveInteger(entry.chapter) || currentChapter || 1,
      marker: normalizeText(entry.marker) || '',
      relativeChronology: normalizeText(entry.relativeChronology) || undefined,
      location: normalizeText(entry.location) || undefined,
      previousLocation: normalizeText(entry.previousLocation) || undefined,
      event: normalizeText(entry.event) || undefined
    })).filter(entry => entry.marker) : [],
    continuitySummary: normalizeText(value.continuitySummary) || undefined,
    consequences: Array.isArray(value.consequences) ? value.consequences.filter(isRecord).map((entry, index) => ({
      id: normalizeText(entry.id) || `consequence_${index + 1}`,
      type: normalizeText(entry.type) || 'consequence',
      description: normalizeText(entry.description) || '',
      createdChapter: normalizePositiveInteger(entry.createdChapter) || currentChapter || 1,
      status: entry.status === 'resolved' ? 'resolved' as const : 'active' as const,
      resolvedChapter: normalizePositiveInteger(entry.resolvedChapter) || undefined
    })).filter(entry => entry.description) : []
  };
}

function normalizeValidationResult(value: unknown): ValidationResult | undefined {
  if (!isRecord(value)) return undefined;
  const violationTypes: readonly ViolationType[] = STORY_VIOLATION_TYPES;
  const normalizeViolations = (raw: unknown): Violation[] => Array.isArray(raw) ? raw.filter(isRecord).map(entry => {
    const severity = entry.severity === 'CRITICAL' || entry.severity === 'HIGH'
      || entry.severity === 'MEDIUM' || entry.severity === 'LOW'
      ? entry.severity : entry.severity === 'WARNING' ? 'LOW' : 'HIGH';
    const chapterNumber = normalizePositiveInteger(entry.chapterNumber) || normalizePositiveInteger(entry.chapter) || undefined;
    const message = normalizeText(entry.message) || normalizeText(entry.reason) || 'Imported story validation issue.';
    const evidence = normalizeText(entry.evidence) || normalizeText(entry.quoteOrDescription) || undefined;
    const suggestedRepair = normalizeText(entry.suggestedRepair) || normalizeText(entry.repairInstruction) || undefined;
    return {
      type: violationTypes.find(type => type === entry.type) || 'WORLD_FACT_CONTRADICTION',
      severity,
      chapterNumber,
      message,
      evidence,
      suggestedRepair,
      chapter: chapterNumber,
      quoteOrDescription: evidence || message,
      reason: message,
      repairInstruction: suggestedRepair || ''
    };
  }) : [];
  const violations = normalizeViolations(value.violations);
  const warnings = normalizeViolations(value.warnings);
  const semanticChecks = isRecord(value.semanticChecks) ? value.semanticChecks : {};
  const pass = value.pass === true;
  const status = value.status === 'QA_UNAVAILABLE' ? 'QA_UNAVAILABLE' : pass ? 'PASS' : 'FAIL';
  return {
    pass,
    status,
    continuityScore: typeof value.continuityScore === 'number' && Number.isFinite(value.continuityScore) ? value.continuityScore : 0,
    pacingScore: typeof value.pacingScore === 'number' && Number.isFinite(value.pacingScore) ? value.pacingScore : 0,
    violations,
    warnings,
    attempts: normalizePositiveInteger(value.attempts) || undefined,
    repairAttempts: typeof value.repairAttempts === 'number' && Number.isInteger(value.repairAttempts) && value.repairAttempts >= 0
      ? value.repairAttempts : undefined,
    modelRole: value.modelRole === 'semantic-validator' ? 'semantic-validator' : undefined,
    semanticChecks: {
      characterGating: semanticChecks.characterGating === true,
      worldFactContinuity: semanticChecks.worldFactContinuity === true,
      spoilerContainment: semanticChecks.spoilerContainment === true,
      pacingIntegrity: semanticChecks.pacingIntegrity === true,
      characterTraitConsistency: semanticChecks.characterTraitConsistency === true
    }
  };
}

function isFullProject(object: Record<string, unknown>): boolean {
  const marker = normalizeText(object.importType) || normalizeText(object.kind) || normalizeText(object.type);
  if (marker?.toUpperCase() === 'FULL_PROJECT') return true;
  return isRecord(object.storyControl) && isRecord(object.storyState) && Array.isArray(object.memoryIndex);
}

function parseFullProjectControl(value: unknown): StoryControl | undefined {
  if (!isRecord(value)) return undefined;
  const storedBlueprint = isRecord(value.authoritativeBlueprint) ? value.authoritativeBlueprint : undefined;
  const blueprintSource = storedBlueprint && isRecord(storedBlueprint.source) ? storedBlueprint.source : (storedBlueprint || value);
  const blueprint = validateBlueprintV3Object(blueprintSource);
  const sourceHash = normalizeText(value.sourceHash) || 'imported_full_project';
  const control = createStoryControlFromBlueprint(blueprint, sourceHash, normalizeJsonObject(value.settings) || undefined);
  if (Array.isArray(value.characterGates)) control.characterGates = value.characterGates.filter(isRecord).map((gate, index) => ({
    characterId: normalizeText(gate.characterId) || `char_${index + 1}`,
    characterName: normalizeText(gate.characterName) || '',
    unlockAtArcId: normalizeText(gate.unlockAtArcId) || control.arcs[0].id,
    unlockAtChapter: normalizePositiveInteger(gate.unlockAtChapter) || 1,
    prerequisiteClues: normalizeStringArray(gate.prerequisiteClues),
    reason: normalizeText(gate.reason) || ''
  })).filter(gate => gate.characterName);
  return control;
}

function parseDirectJson(text: string): ParsedSetupFile | null {
  const object = parseJsonObject(text, 'File import');
  const fullProject = isFullProject(object);
  const nestedBlueprint = isRecord(object.blueprintV3) ? object.blueprintV3 : undefined;
  const blueprintSource = nestedBlueprint || (Array.isArray(object.arcs) ? object : undefined);
  const blueprintV3 = blueprintSource ? validateBlueprintV3Object(blueprintSource) : undefined;
  const storyControl = fullProject
    ? parseFullProjectControl(object.storyControl)
    : blueprintV3 ? createStoryControlFromBlueprint(blueprintV3) : undefined;
  const effectiveBlueprint = blueprintV3 || storyControl?.authoritativeBlueprint;
  return {
    importKind: fullProject ? 'FULL_PROJECT' : 'AUTHOR_SETUP',
    seedTitle: normalizeText(object.seedTitle) || normalizeText(object.title) || '',
    genre: normalizeText(object.genre) || '',
    premise: normalizeText(object.premise) || normalizeText(object.seriesPremise) || '',
    worldNotes: normalizeText(object.worldNotes) || '',
    charNotes: normalizeText(object.charNotes) || '',
    outline: normalizeText(object.outline) || '',
    characters: normalizeCharacters(object.characters),
    seriesPremise: normalizeText(object.seriesPremise) || normalizeText(object.premise) || undefined,
    continuitySummary: normalizeText(object.continuitySummary) || normalizeText(object.premise) || undefined,
    storyEngineSettingsV3: normalizeJsonObject(object.storyEngineSettingsV3) || normalizeJsonObject(object.settingsV3) || undefined,
    blueprintV3: effectiveBlueprint,
    storyControl,
    storyState: fullProject ? normalizeStoryState(object.storyState, storyControl?.sourceHash) : undefined,
    memoryIndex: fullProject ? normalizeMemoryIndex(object.memoryIndex, storyControl?.sourceHash) : undefined,
    chapters: fullProject ? normalizeChapters(object.chapters) : undefined,
    lastValidationResult: fullProject ? normalizeValidationResult(object.lastValidationResult) : undefined
  };
}

export function parseSetupFileContent(text: string): ParsedSetupFile | null {
  if (!normalizeText(text)) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return parseDirectJson(trimmed);
  if (!text.includes('[')) return null;

  const titleMatch = text.match(/^THIẾT LẬP SÁNG TÁC:\s*(.*)$/m);
  const rawTitle = normalizeText(titleMatch?.[1]);
  const seedTitle = rawTitle && !PLACEHOLDER_VALUES.has(rawTitle) ? rawTitle : '';
  const genre = getSection(text, 'THỂ LOẠI');
  const premise = getSection(text, 'TIỀN ĐỀ / TÓM TẮT');
  const worldNotes = getSection(text, 'THẾ GIỚI');
  const characterSection = getSection(text, 'NHÂN VẬT');
  const charNotes = getSection(text, 'GHI CHÚ NHÂN VẬT KHÁC');
  const outline = getSection(text, 'DÀN Ý');
  const settingsBlock = getSection(text, 'STORY_ENGINE_SETTINGS_V3');
  const blueprintBlock = getSection(text, 'STORY_ENGINE_BLUEPRINT_V3') || getSection(text, 'BLUEPRINT_V3');
  if (!seedTitle && !genre && !premise && !worldNotes && !characterSection && !charNotes && !outline
    && !settingsBlock && !blueprintBlock) return null;
  const settings = settingsBlock ? parseJsonObject(settingsBlock, 'STORY_ENGINE_SETTINGS_V3') : undefined;
  const blueprintV3 = blueprintBlock ? validateBlueprintV3Object(parseJsonObject(blueprintBlock, 'STORY_ENGINE_BLUEPRINT_V3')) : undefined;
  const storyControl = blueprintV3 ? createStoryControlFromBlueprint(blueprintV3, 'custom_unhashed', settings) : undefined;
  const characters = characterSection
    ? characterSection.split(/\r?\n\s*\r?\n+/).map(parseCharacterBlock).filter((character): character is Character => character !== null)
    : [];

  const legacyMeta = getSection(text, 'STORY_ENGINE_META_V2');
  if (legacyMeta) {
    const meta = parseJsonObject(legacyMeta, 'STORY_ENGINE_META_V2');
    const legacyControl = parseFullProjectControl(meta.storyControl);
    return {
      importKind: 'FULL_PROJECT',
      seedTitle,
      genre,
      premise,
      worldNotes,
      charNotes,
      outline,
      characters,
      seriesPremise: normalizeText(meta.seriesPremise) || premise,
      continuitySummary: normalizeText(meta.continuitySummary) || premise,
      blueprintV3: legacyControl?.authoritativeBlueprint,
      storyControl: legacyControl,
      storyState: normalizeStoryState(meta.storyState, legacyControl?.sourceHash),
      memoryIndex: normalizeMemoryIndex(meta.memoryIndex, legacyControl?.sourceHash),
      chapters: normalizeChapters(meta.chapters),
      lastValidationResult: normalizeValidationResult(meta.lastValidationResult)
    };
  }

  return {
    importKind: 'AUTHOR_SETUP',
    seedTitle,
    genre,
    premise,
    worldNotes,
    charNotes,
    outline,
    characters,
    seriesPremise: normalizeText(settings?.seriesPremise) || premise,
    continuitySummary: normalizeText(settings?.continuitySummary) || premise,
    storyEngineSettingsV3: settings,
    blueprintV3,
    storyControl
  };
}

export function applySetupImport(previous: CreativeState, parsed: ParsedSetupFile): CreativeState {
  const common: CreativeState = {
    ...previous,
    setup: {
      seedTitle: parsed.seedTitle,
      genre: parsed.genre,
      premise: parsed.premise,
      worldNotes: parsed.worldNotes,
      charNotes: parsed.charNotes,
      outline: parsed.outline
    },
    characters: parsed.characters,
    seriesPremise: parsed.seriesPremise || parsed.premise,
    continuitySummary: parsed.continuitySummary || parsed.premise,
    storyEngineSettingsV3: parsed.storyEngineSettingsV3,
    blueprintV3: parsed.blueprintV3,
    storyEngineSanity: undefined
  };
  if (parsed.importKind === 'FULL_PROJECT') {
    return {
      ...common,
      chapters: parsed.chapters || previous.chapters,
      storyControl: parsed.storyControl,
      storyState: parsed.storyState,
      memoryIndex: parsed.memoryIndex,
      lastValidationResult: parsed.lastValidationResult
    };
  }
  return {
    ...common,
    storyControl: parsed.storyControl,
    storyState: undefined,
    memoryIndex: undefined,
    lastValidationResult: undefined,
    snapshots: [],
    summary: '',
    suggestions: []
  };
}
