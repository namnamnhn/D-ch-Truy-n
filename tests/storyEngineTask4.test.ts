import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Character, CreativeChapter } from '../src/types';
import {
  ChapterMemory, StoryBible, StoryControl, StoryState, STORY_CONTROL_SCHEMA_VERSION,
  STORY_STATE_SCHEMA_VERSION, MEMORY_SCHEMA_VERSION, extractAndMergeState, normalizeStateDelta,
  mergeCumulativeContinuity, mergeKnowledgeEntries, scoreMemoryRelevance, retrieveRelevantMemories,
  compactMemoryIndex, compactMemoryIndexSafely, formatMemoriesForContext, sanitizeMemoriesForReader,
  getAllStoryModelRoutes, getStoryModelRoute, getStoryModelCandidates, createDeterministicStoryControl, mergeExtractedCharacters,
  runStoryEngineSanityCheck, canReuseDerivedState, compatibleMemories, createPlannerView, createWriterView,
  createValidatorView, validateWriterOutput, parseSetupFileContent, applySetupImport
} from '../src/services/storyEngine';

const hero: Character = { id: 'hero', name: 'Hero', gender: '', age: '', role: 'lead', appearance: '', personality: '' };

function bible(genre = 'Mystery', worldNotes = 'A rain-soaked coastal city.'): StoryBible {
  return { seedTitle: 'Test', genre, seriesPremise: 'A witness investigates a disappearance.', continuitySummary: 'An old oath remains unpaid.',
    worldNotes, charNotes: '', outline: 'Investigate without exposing the culprit early.', characters: [hero], totalPlannedChapters: 20 };
}

function control(arcs = 2): StoryControl {
  const total = arcs * 10;
  return {
    version: 'v3', schemaVersion: STORY_CONTROL_SCHEMA_VERSION, sourceHash: 'hash', totalChapters: total,
    arcs: Array.from({ length: arcs }, (_, i) => ({ id: `arc_${i + 1}`, title: `Arc ${i + 1}`, startChapter: i * 10 + 1,
      endChapter: i * 10 + 10, theme: 'Investigation', coreConflict: 'Find evidence', climaxChapter: i * 10 + 9,
      pacing: 'accelerating' as const, unlockedCharacterIds: ['hero'], keyMilestones: [], worldBuildingFocus: 'City',
      forbiddenSpoilers: i ? ['FUTURE_SPOILER'] : [] })),
    characterRegistry: { hero: { id: 'hero', name: 'Hero', aliasSet: ['The Witness'], role: 'lead', appearance: '', personality: '',
      coreMotivation: 'truth', forbiddenSpoilers: [], unlockCondition: { type: 'chapter', value: 1 }, allowedArcs: ['arc_1', 'arc_2'], restrictions: [] },
      future: { id: 'future', name: 'Future Person', aliasSet: ['Masked Future'], role: 'future', appearance: '', personality: '',
        coreMotivation: '', forbiddenSpoilers: ['FUTURE_CHARACTER_SECRET'], unlockCondition: { type: 'chapter', value: 11 },
        allowedArcs: ['arc_2'], unlockChapter: 11, restrictions: [] } },
    worldFacts: [{ id: 'public', category: 'history', fact: 'The station closed years ago.', scope: 'public', visibility: 'always', introducedAtChapter: 1 },
      { id: 'secret', category: 'secret_rule', fact: 'LOCKED_WORLD_SECRET', secretTruth: 'WORLD_ACTUAL_TRUTH', scope: 'hidden_truth', visibility: 'author_only', introducedAtChapter: 1 }],
    narrativeExposureRules: [], characterGates: [{ characterId: 'future', characterName: 'Future Person', unlockAtArcId: 'arc_2', unlockAtChapter: 11, prerequisiteClues: [], reason: '' }],
    spoilerGates: [], continuityRules: { enforcePhysicalInjuryDuration: true, enforceResourceTracking: true, enforceRelationshipMemory: true, enforceClueDiscoveryProgression: true },
    pacingRules: { minWordsPerChapter: 1, maxWordsPerChapter: 5000, climaxPacingMultiplier: 1, cooldownChaptersAfterClimax: 1 },
    mysteryThreads: [{ id: 'mystery', question: 'Who?', actualTruth: 'MYSTERY_ACTUAL_TRUTH', stages: [] }], authorOnlySecrets: ['AUTHOR_SECRET'], settings: {},
    authoritativeBlueprint: { characterRegistry: [], worldFacts: [], arcs: [], narrativeExposureRules: [], mysteryThreads: [], characterGates: [], spoilerGates: [], authorOnlySecrets: [], source: {} }
  };
}

function state(chapter = 0): StoryState {
  return { schemaVersion: STORY_STATE_SCHEMA_VERSION, sourceHash: 'hash', currentChapter: chapter, characterStates: {}, relationships: [], resources: {}, clues: [],
    unresolvedThreads: ['mystery'], longTermSeeds: [], recentConsequences: [], currentArcId: 'arc_1', currentArcProgress: 0,
    unlockedCharacterIds: ['hero'], worldFactStates: { public: 'revealed', secret: 'hidden' }, knowledgeLedger: [], timeline: [],
    continuitySummary: 'Chapter 1: the mentor died and the oath remained unpaid.' };
}

function chapter(number = 2): CreativeChapter {
  return { id: `c${number}`, chapterNumber: number, title: `Chapter ${number}`, content: 'At night Hero reaches the harbor and records an observable clue.', status: 'completed' };
}

function memory(number: number, extra: Partial<ChapterMemory> = {}): ChapterMemory {
  return { id: `m${number}`, schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: 'hash', chapterNumber: number, title: `C${number}`, summary: `event ${number}`,
    charactersInvolved: [], locations: [], importance: 50, resolved: false, ...extra };
}

async function merge(delta: unknown, previous = state(1)) {
  return extractAndMergeState([chapter(2)], previous, control(), [hero], undefined, 2, async () => JSON.stringify(delta));
}

describe('Story Engine Task 4 regressions', () => {
  it('1 drops actualTruth from AI delta', () => { const result = normalizeStateDelta({ actualTruth: 'invented' }); expect(JSON.stringify(result.delta)).not.toContain('invented'); expect(result.warnings.join()).toContain('AUTHOR_TRUTH_DROPPED'); });
  it('2 drops author-only secrets from AI delta', () => { const result = normalizeStateDelta({ authorOnlySecrets: ['invented'] }); expect(JSON.stringify(result.delta)).not.toContain('invented'); });
  it('3 keeps a major prior event in cumulative continuity', () => expect(mergeCumulativeContinuity('The mentor died.', 'Hero reached the harbor.', 100)).toContain('mentor died'));
  it('4 compaction keeps unresolved mystery memory', () => { const all = [memory(1, { threadIds: ['mystery'] }), ...Array.from({ length: 10 }, (_, i) => memory(i + 2, { resolved: true }))]; expect(compactMemoryIndex(all, 3).some(item => item.id === 'm1')).toBe(true); });
  it('5 compaction keeps active injury memory', () => { const s = state(); s.characterStates.hero = { characterId: 'hero', name: 'Hero', location: '', physicalCondition: '', knownFacts: [], goals: [], injuries: [{ id: 'wound', type: 'wound', bodyPart: 'leg', severity: 'severe', receivedChapter: 1, expectedRecoveryChapter: 2, restrictions: [], status: 'active' }] }; expect(compactMemoryIndex([memory(1, { injuryIds: ['wound'] }), ...Array.from({ length: 5 }, (_, i) => memory(i + 2, { resolved: true }))], 2, s).some(item => item.id === 'm1')).toBe(true); });
  it('6 compactor failure preserves old memory', async () => { const all = Array.from({ length: 5 }, (_, i) => memory(i + 1)); expect(await compactMemoryIndexSafely(all, 2, undefined, async () => { throw new Error('fail'); })).toEqual(all); });
  it('7 knowledge records learnedChapter', async () => expect((await merge({ knowledge: [{ factId: 'door', fact: 'Door open', source: 'witnessed', confidence: 1 }] })).nextState.knowledgeLedger?.[0].learnedChapter).toBe(2));
  it('8 knowledge records source', async () => expect((await merge({ knowledge: [{ fact: 'Letter exists', source: 'document', confidence: .9 }] })).nextState.knowledgeLedger?.[0].source).toBe('document'));
  it('9 belief interpretation remains distinct from canonical truth', async () => { const result = await merge({ knowledge: [{ factId: 'culprit', fact: 'Hero suspects A', interpretation: 'A did it', source: 'inference', confidence: .4 }] }); expect(result.nextState.knowledgeLedger?.[0].interpretation).toBe('A did it'); expect(JSON.stringify(result.nextState)).not.toContain('MYSTERY_ACTUAL_TRUTH'); });
  it('10 duplicate knowledge merges deterministically', () => { const one = mergeKnowledgeEntries([], [{ factId: 'x', fact: 'X', source: 'witnessed', confidence: .8 }], 2); expect(mergeKnowledgeEntries(one, [{ factId: 'x', fact: 'X', source: 'witnessed', confidence: 1, learnedChapter: 2 }], 2)).toHaveLength(1); });
  it('11 malformed knowledge does not crash', () => expect(() => normalizeStateDelta({ knowledge: [null, 4, {}] })).not.toThrow());
  it('12 same fact learned by two characters stays distinct', () => expect(mergeKnowledgeEntries([], [{ factId: 'x', fact: 'X', characterId: 'a', source: 'told_by', confidence: .5 }, { factId: 'x', fact: 'X', characterId: 'b', source: 'told_by', confidence: .5 }], 2)).toHaveLength(2));
  it('13 time marker is preserved', async () => expect((await merge({ timeline: [{ marker: 'next morning', relativeChronology: 'next_day' }] })).nextState.timeline?.[0].marker).toBe('next morning'));
  it('14 location transition is preserved', async () => { const s = state(1); s.characterStates.hero = { characterId: 'hero', name: 'Hero', location: 'Home', physicalCondition: '', injuries: [], knownFacts: [], goals: [] }; const result = await merge({ timeline: [{ marker: 'evening', characterName: 'Hero', previousLocation: 'Home', location: 'Harbor' }] }, s); expect(result.nextState.characterStates.hero).toMatchObject({ location: 'Harbor', priorLocation: 'Home' }); });
  it('15 severe injury does not auto-recover by expected chapter', async () => { const s = state(20); s.characterStates.hero = { characterId: 'hero', name: 'Hero', location: '', physicalCondition: '', knownFacts: [], goals: [], injuries: [{ id: 'leg', type: 'break', bodyPart: 'leg', severity: 'severe', receivedChapter: 1, expectedRecoveryChapter: 5, restrictions: ['walk'], status: 'active' }] }; const result = await extractAndMergeState([chapter(21)], s, control(3), [hero], '', 21); expect(result.nextState.characterStates.hero.injuries[0].status).toBe('active'); });
  it('16 explicit recovered delta resolves injury', async () => { const s = state(1); s.characterStates.hero = { characterId: 'hero', name: 'Hero', location: '', physicalCondition: '', knownFacts: [], goals: [], injuries: [{ id: 'leg', type: 'break', bodyPart: 'leg', severity: 'severe', receivedChapter: 1, expectedRecoveryChapter: 5, restrictions: ['walk'], status: 'active' }] }; const result = await merge({ injuries: [{ injuryId: 'leg', characterName: 'Hero', type: 'break', bodyPart: 'leg', severity: 'severe', durationChapters: 4, restrictions: [], status: 'recovered' }] }, s); expect(result.nextState.characterStates.hero.injuries[0].status).toBe('recovered'); });
  it('17 partial resources preserve prior arrays', async () => { const s = state(1); s.resources = { equipment: ['key'], properties: ['flat'] }; const result = await merge({ resources: { equipment: ['lamp'] } }, s); expect(result.nextState.resources).toMatchObject({ equipment: ['key', 'lamp'], properties: ['flat'] }); });
  it('18 partial relationship preserves prior fields', async () => { const s = state(1); s.relationships = [{ characterA: 'Hero', characterB: 'Ally', trust: 80, hostility: 5, stage: 'friends', debt: 'favor', lastMajorChangeChapter: 1 }]; const result = await merge({ relationships: [{ characterA: 'Hero', characterB: 'Ally', hostility: 10 }] }, s); expect(result.nextState.relationships[0]).toMatchObject({ trust: 80, stage: 'friends', debt: 'favor' }); });
  it('19 extracted memory has arc metadata', async () => expect((await merge({ chapterSummaries: [{ chapterNumber: 2, summary: 'x' }] })).newMemories[0].arcId).toBe('arc_1'));
  it('20 memory supports thread location and seed metadata', () => expect(memory(1, { threadIds: ['t'], locations: ['L'], seedIds: ['s'] })).toMatchObject({ threadIds: ['t'], locations: ['L'], seedIds: ['s'] }));
  it('21 old relevant seed outranks irrelevant recent memory', () => { const old = memory(12, { seedIds: ['payoff'] }); const recent = memory(179); expect(scoreMemoryRelevance(old, { currentChapter: 180, seedIds: ['payoff'] })).toBeGreaterThan(scoreMemoryRelevance(recent, { currentChapter: 180, seedIds: ['payoff'] })); });
  it('22 exact thread match is prioritized', () => expect(scoreMemoryRelevance(memory(1, { threadIds: ['t'] }), { currentChapter: 100, threadIds: ['t'] })).toBeGreaterThan(500));
  it('23 active injury memory is retrieved', () => expect(retrieveRelevantMemories([memory(1, { injuryIds: ['leg'] }), memory(99)], { currentChapter: 100, injuryIds: ['leg'] }, 1)[0].chapterNumber).toBe(1));
  it('24 resolved low-priority memory can compact', () => { const old = memory(1, { resolved: true, importance: 1 }); expect(compactMemoryIndex([old, memory(2, { importance: 90 }), memory(3, { importance: 80 })], 2)).not.toContainEqual(old); });
  it('25 writer memory budget is bounded', () => expect(formatMemoriesForContext([memory(1, { summary: 'x'.repeat(20000) })]).length).toBeLessThanOrEqual(12000));
  it('26 writer memory redacts author secret', () => expect(sanitizeMemoriesForReader([memory(1, { summary: 'AUTHOR_SECRET' })], control())[0].summary).not.toContain('AUTHOR_SECRET'));
  it('27 writer memory redacts mystery actual truth', () => expect(sanitizeMemoriesForReader([memory(1, { summary: 'MYSTERY_ACTUAL_TRUTH' })], control())[0].summary).not.toContain('MYSTERY_ACTUAL_TRUTH'));
  it('28 validator view preserves relevant older state facts', () => { const s = state(); s.knowledgeLedger = [{ factId: 'old', fact: 'Old fact', learnedChapter: 1, source: 'witnessed', confidence: 1 }]; const plan = { arcId: 'arc_1', startChapter: 2, endChapter: 2, chapters: [{ chapterNumber: 2, title: '', focus: '', povCharacter: 'hero', pacingTarget: 'rising_action' as const, requiredEvents: [], introducedCharacters: [], activeCharacters: [], worldFactInteractions: [], cluesDiscovered: [], forbiddenSpoilers: [] }], batchDirectives: [], charactersGated: [], antiDriftMeasures: [], planValid: true }; expect(JSON.stringify(createValidatorView(control(), plan, s, 2))).toContain('Old fact'); });
  it('29 all required model roles resolve centrally', () => expect(getAllStoryModelRoutes()).toHaveLength(8));
  it('30 semantic validator uses a QUALITY no-Lite policy', () => { expect(getStoryModelRoute('STORY_VALIDATOR_SEMANTIC')).toMatchObject({ tier: 'QUALITY', requiredInStrictMode: true, allowFastFallback: false, qualityFloor: 'FLASH' }); expect(getStoryModelCandidates('STORY_VALIDATOR_SEMANTIC')).not.toContain('gemini-3.5-flash-lite'); });
  it('31 state extractor uses FAST', () => expect(getStoryModelRoute('STATE_EXTRACTOR').tier).toBe('FAST'));
  it('32 model IDs only occur in routing config', () => { const dir = join(process.cwd(), 'src/services/storyEngine'); const offenders = readdirSync(dir).filter(name => name.endsWith('.ts') && name !== 'modelRouting.ts' && !name.endsWith('.test.ts')).filter(name => /gemini-\d/.test(readFileSync(join(dir, name), 'utf8'))); expect(offenders).toEqual([]); });
  it('33 generic auto-fill has no cultivation assumptions', () => { const result = createDeterministicStoryControl(bible(), 'x', 20); expect(JSON.stringify(result).toLocaleLowerCase()).not.toMatch(/tu luyện|cảnh giới|linh khí|cultivation/); });
  it('34 explicit cultivation input remains supported', () => expect(JSON.stringify(createDeterministicStoryControl(bible('Tiên Hiệp', 'Hệ thống tu luyện có chín cảnh giới.'), 'x', 20))).toContain('tu luyện'));
  it('35 new character merge preserves existing characters', () => expect(mergeExtractedCharacters([hero], [{ ...hero, id: 'new', name: 'New' }])).toHaveLength(2));
  it('36 malformed extracted character cannot overwrite canonical profile', () => expect(mergeExtractedCharacters([hero], [{ ...hero, id: '', name: 'Hero', role: 'wrong' } as Character])[0].role).toBe('lead'));
  it('37 locked future registry character does not activate in UI', () => expect(mergeExtractedCharacters([hero], [{ ...hero, id: 'future', name: 'Future Person' }], control(), 1)).toEqual([hero]));
  it('38 valid V3 project is READY', () => expect(runStoryEngineSanityCheck({ bible: bible(), control: control(), state: state(), modelAvailability: { FAST: true, QUALITY: true } }).pass).toBe(true));
  it('39 hidden writer secret leak is BLOCKED', () => { const c = control(); c.settings = { readerSafePremise: 'AUTHOR_SECRET' }; const result = runStoryEngineSanityCheck({ bible: bible(), control: c, state: state() }); expect(result.pass).toBe(false); expect(result.writerContextLeakCheck).toBe(false); });
  it('40 missing arc is BLOCKED', () => { const c = control(); c.arcs = c.arcs.slice(0, 1); const result = runStoryEngineSanityCheck({ bible: bible(), control: c, chapter: 15 }); expect(result.pass).toBe(false); expect(result.errors.join()).toContain('ARC_MISSING'); });
  it('41 sanity result never returns raw author secret', () => expect(JSON.stringify(runStoryEngineSanityCheck({ bible: bible(), control: control(), state: state() }))).not.toContain('AUTHOR_SECRET'));
  it('42 sanity reports exact 38 authoritative arcs', () => { const c = control(38); const result = runStoryEngineSanityCheck({ bible: { ...bible(), totalPlannedChapters: 380 }, control: c, chapter: 1 }); expect(result.arcCount).toBe(38); expect(result.exactArcCoverage).toBe(true); });
  it('43 incompatible StoryState schema is not reused', () => expect(canReuseDerivedState({ ...state(), schemaVersion: undefined }, 'hash')).toBe(false));
  it('44 sourceHash mismatch invalidates state and memory', () => { expect(canReuseDerivedState(state(), 'other')).toBe(false); expect(compatibleMemories([memory(1)], 'other')).toEqual([]); });
  it('45 strict semantic model unavailable blocks sanity', () => expect(runStoryEngineSanityCheck({ bible: bible(), control: control(), modelAvailability: { FAST: true, QUALITY: false } }).errors.join()).toContain('STORY_VALIDATOR_SEMANTIC'));
  it('46 reader projection excludes actual truth', () => expect(JSON.stringify(createPlannerView(bible(), control(), state(), [], 1, []))).not.toContain('MYSTERY_ACTUAL_TRUTH'));
  it('47 planner chapter projection keeps future character isolated', () => expect(JSON.stringify(createPlannerView(bible(), control(), state(), [], 1, []))).not.toContain('Future Person'));
  it('48 writer parser preserves exact output contract', () => expect(validateWriterOutput('<CHAPTER number="1" title="Chương 1: One">text</CHAPTER>', [1]).chapters.map(item => item.chapterNumber)).toEqual([1]));
  it('49 authoritative blueprint parser remains available through setup import', () => expect(parseSetupFileContent(JSON.stringify({ seedTitle: 'x', genre: 'y', premise: 'z', worldNotes: '', outline: '', characters: [] }))?.importKind).toBe('AUTHOR_SETUP'));
  it('50 FULL_PROJECT migration attaches compatible schema/source metadata', () => { const c = control(); const parsed = parseSetupFileContent(JSON.stringify({ importType: 'FULL_PROJECT', seedTitle: 'x', genre: 'y', premise: 'z', characters: [], storyControl: { ...c, authoritativeBlueprint: { schemaVersion: 3, totalChapters: 20, characterRegistry: Object.values(c.characterRegistry), worldFacts: c.worldFacts, arcs: c.arcs, narrativeExposureRules: [], mysteryThreads: [], characterGates: c.characterGates, spoilerGates: [], authorOnlySecrets: [], source: { arcs: c.arcs, characterRegistry: Object.values(c.characterRegistry), worldFacts: c.worldFacts } } }, storyState: state(), memoryIndex: [memory(1)] }))!; const restored = applySetupImport({ prompt: '', chapters: [], summary: '', suggestions: [], isGenerating: false, isSummarizing: false, targetChapters: 1 }, parsed); expect(restored.storyState?.schemaVersion).toBe(STORY_STATE_SCHEMA_VERSION); expect(restored.memoryIndex?.[0].sourceHash).toBe(restored.storyControl?.sourceHash); });
  it('51 promise/debt consequence lifecycle requires explicit resolution', async () => { const first = await merge({ promises: [{ id: 'oath', description: 'Return the key' }] }); const second = await extractAndMergeState([chapter(3)], first.nextState, control(), [hero], '', 3, async () => JSON.stringify({ resolvedConsequenceIds: ['oath'] })); expect(first.nextState.consequences?.[0].status).toBe('active'); expect(second.nextState.consequences?.[0].status).toBe('resolved'); });
});
