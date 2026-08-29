import { describe, expect, test } from 'vitest';
import { compileStoryControl, computeBibleHash, createDeterministicStoryControl } from '../src/services/storyEngine/compiler';
import { canReuseStoryControl } from '../src/services/storyEngine/pipeline';
import {
  extractAndMergeState,
  parseStateDeltaResponse
} from '../src/services/storyEngine/stateExtractor';
import {
  applySetupImport,
  parseSetupFileContent
} from '../src/services/storyEngine/setupImport';
import { parseBlueprintContent, validateBlueprintV3Object } from '../src/services/storyEngine/blueprintParser';
import {
  AuthoritativeBlueprintV3,
  StoryBible,
  StoryState,
  STORY_CONTROL_SCHEMA_VERSION
} from '../src/services/storyEngine/types';
import { Character, CreativeState } from '../src/types';

function makeBlueprintRaw() {
  return {
    schemaVersion: 3,
    settings: { totalChapters: 600, language: 'vi' },
    characterRegistry: [
      {
        id: 'hero',
        name: 'An',
        aliases: ['A'],
        role: 'protagonist',
        appearance: 'Áo xanh',
        personality: 'Điềm tĩnh',
        unlockChapter: 1
      },
      {
        id: 'future',
        name: 'Bình',
        aliases: ['B'],
        gender: 'Nam',
        age: 30,
        role: 'future rival',
        appearance: 'Áo đen',
        personality: 'Thận trọng',
        relationships: [{ with: 'An', type: 'rival' }],
        restrictions: ['Không xuất hiện sớm'],
        unlockChapter: 120,
        directAppearanceChapter: 130,
        povUnlockChapter: 180,
        majorFocusNotBeforeChapter: 200
      }
    ],
    worldFacts: [
      { id: 'public', fact: 'Bầu trời xanh', visibility: 'always' },
      { id: 'gated', fact: 'Cổng cổ', visibility: 'gated', unlockChapter: 80 },
      { id: 'secret', fact: 'Nguồn gốc thế giới', visibility: 'author_only', revealChapter: 500 }
    ],
    arcs: Array.from({ length: 38 }, (_, index) => {
      const startChapter = index * 15 + 1;
      const endChapter = index === 37 ? 600 : startChapter + 14;
      return {
        id: `arc_${String(index + 1).padStart(2, '0')}`,
        title: `Hồi ${index + 1}`,
        startChapter,
        endChapter,
        climaxChapter: endChapter,
        theme: `Chủ đề ${index + 1}`
      };
    }),
    narrativeExposureRules: [
      { id: 'exposure_1', topic: 'Cổng cổ', unlockChapter: 80 },
      { id: 'exposure_2', topic: 'Nguồn gốc', unlockChapter: 500 }
    ],
    mysteryThreads: [{ id: 'mystery_1', question: 'Ai mở cổng?' }],
    spoilerGates: [{ id: 'spoiler_1', description: 'Không lộ trùm cuối', forbiddenBeforeChapter: 500 }],
    originality: { forbiddenComparisons: ['Tác phẩm X'] },
    authorOnlySecrets: [{ id: 'truth_1', text: 'An là người giữ chìa khóa' }]
  };
}

function makeSetup(blueprintLabel = 'STORY_ENGINE_BLUEPRINT_V3', blueprint = makeBlueprintRaw()): string {
  return `THIẾT LẬP SÁNG TÁC: Truyện Test
[THỂ LOẠI]
Kỳ ảo
[TIỀN ĐỀ / TÓM TẮT]
Một hành trình dài.
[THẾ GIỚI]
Thế giới thử nghiệm.
[NHÂN VẬT]
- An (Nhân vật chính), Nam, 20 tuổi
  Ngoại hình: Áo xanh
  Tính cách: Điềm tĩnh
[GHI CHÚ NHÂN VẬT KHÁC]
Không có.
[DÀN Ý]
Giữ đúng blueprint.
[${blueprintLabel}]
${JSON.stringify(blueprint, null, 2)}`;
}

function makeBible(blueprintV3?: AuthoritativeBlueprintV3): StoryBible {
  return {
    seedTitle: 'Truyện Test',
    genre: 'Kỳ ảo',
    seriesPremise: 'Một hành trình dài.',
    continuitySummary: '',
    worldNotes: 'Thế giới thử nghiệm.',
    charNotes: 'Ghi chú.',
    outline: 'Dàn ý.',
    characters: [{
      id: 'hero', name: 'An', gender: 'Nam', age: '20', role: 'Chính', appearance: 'Áo xanh', personality: 'Điềm tĩnh'
    }],
    totalPlannedChapters: 600,
    storyEngineSettingsV3: { temperature: 0.2 },
    blueprintV3
  };
}

function makeStoryState(): StoryState {
  return {
    currentChapter: 0,
    characterStates: {},
    relationships: [],
    resources: { money: '10' },
    clues: [],
    unresolvedThreads: ['Vấn đề cũ'],
    longTermSeeds: [],
    recentConsequences: [],
    currentArcId: 'arc_1',
    currentArcProgress: 0,
    unlockedCharacterIds: [],
    worldFactStates: {},
    activeFactions: []
  };
}

function makeCreativeState(): CreativeState {
  return {
    prompt: '',
    chapters: [{ id: 'old_chapter', title: 'Chương cũ', content: 'Nội dung cũ' }],
    summary: 'derived summary',
    suggestions: ['derived suggestion'],
    isGenerating: false,
    isSummarizing: false,
    targetChapters: 2,
    characters: [{ id: 'old', name: 'Cũ', gender: '', age: '', role: '', appearance: '', personality: '' }],
    storyControl: createDeterministicStoryControl(makeBible(), 'old_hash', 600),
    storyState: makeStoryState(),
    memoryIndex: [{ chapterNumber: 1, title: 'Cũ', summary: 'Cũ', charactersInvolved: [], locations: [] }],
    lastValidationResult: {
      pass: true,
      status: 'PASS',
      continuityScore: 100,
      pacingScore: 100,
      violations: [],
      semanticChecks: {
        characterGating: true,
        worldFactContinuity: true,
        spoilerContainment: true,
        pacingIntegrity: true,
        characterTraitConsistency: true
      }
    },
    snapshots: [{
      id: 'old_snapshot', createdAt: 1, chapterCountBefore: 0, chapters: [], characters: [], premise: ''
    }]
  };
}

async function runExtractor(rawDelta: string, state = makeStoryState(), characters: Character[] = makeBible().characters) {
  const control = createDeterministicStoryControl(makeBible(), 'hash', 600);
  return extractAndMergeState(
    [{ id: 'chapter_1', title: 'Chương 1', content: 'Nội dung chương đã nghiệm thu.' }],
    state,
    control,
    characters,
    undefined,
    1,
    async () => rawDelta
  );
}

describe('Story Engine Task 1 - V3 import and data integrity', () => {
  test('1. settings block parses independently', () => {
    const parsed = parseSetupFileContent(`[STORY_ENGINE_SETTINGS_V3]\n{"temperature":0.4}`);
    expect(parsed?.storyEngineSettingsV3?.temperature).toBe(0.4);
    expect(parsed?.storyControl).toBeUndefined();
  });

  test('2. STORY_ENGINE_BLUEPRINT_V3 parses independently', () => {
    const parsed = parseSetupFileContent(`[STORY_ENGINE_BLUEPRINT_V3]\n${JSON.stringify(makeBlueprintRaw())}`);
    expect(parsed?.storyControl?.arcs).toHaveLength(38);
  });

  test('3. BLUEPRINT_V3 backward alias parses', () => {
    const parsed = parseSetupFileContent(makeSetup('BLUEPRINT_V3'));
    expect(parsed?.storyControl?.arcs[0].id).toBe('arc_01');
  });

  test('4. settings JSON containing storyControl is not treated as blueprint', () => {
    const prefix = makeSetup().split('[STORY_ENGINE_BLUEPRINT_V3]')[0];
    const parsed = parseSetupFileContent(`${prefix}[STORY_ENGINE_SETTINGS_V3]\n{"storyControl":{"arcs":[{"id":"bad"}]}}`);
    expect(parsed?.storyControl).toBeUndefined();
    expect(parsed?.storyEngineSettingsV3?.storyControl).toBeTruthy();
  });

  test('5. explicit 38-arc blueprint stays authoritative and never calls AI regeneration', async () => {
    const blueprint = validateBlueprintV3Object(makeBlueprintRaw());
    let runnerCalled = false;
    const compiled = await compileStoryControl(makeBible(blueprint), async () => {
      runnerCalled = true;
      return '{}';
    });
    expect(compiled.arcs).toHaveLength(38);
    expect(runnerCalled).toBe(false);
  });

  test('6. exact chapter ranges survive parse', () => {
    const arcs = parseSetupFileContent(makeSetup())?.storyControl?.arcs || [];
    expect(arcs.map(arc => [arc.startChapter, arc.endChapter])).toEqual(
      makeBlueprintRaw().arcs.map(arc => [arc.startChapter, arc.endChapter])
    );
  });

  test('7. characterRegistry array loads into full authoritative registry', () => {
    const control = parseSetupFileContent(makeSetup())?.storyControl;
    expect(control?.authoritativeBlueprint?.characterRegistry).toHaveLength(2);
    expect(control?.characterRegistry.future.povUnlockChapter).toBe(180);
  });

  test('8. future registry characters are not activated in UI characters', () => {
    const parsed = parseSetupFileContent(makeSetup());
    expect(parsed?.characters.map(character => character.name)).toEqual(['An']);
    expect(parsed?.storyState).toBeUndefined();
  });

  test('9. worldFacts visibility values are preserved', () => {
    const facts = parseSetupFileContent(makeSetup())?.storyControl?.worldFacts || [];
    expect(facts.map(fact => fact.visibility)).toEqual(['always', 'gated', 'author_only']);
  });

  test('10. narrativeExposureRules array is preserved', () => {
    expect(parseSetupFileContent(makeSetup())?.storyControl?.narrativeExposureRules).toEqual(makeBlueprintRaw().narrativeExposureRules);
  });

  test('11. mysteryThreads are preserved', () => {
    expect(parseSetupFileContent(makeSetup())?.storyControl?.mysteryThreads).toEqual(makeBlueprintRaw().mysteryThreads);
  });

  test('12. authorOnlySecrets persist only in control blueprint data', () => {
    const parsed = parseSetupFileContent(makeSetup());
    expect(parsed?.storyControl?.authorOnlySecrets).toEqual(makeBlueprintRaw().authorOnlySecrets);
    expect(parsed?.characters.some(character => character.name.includes('chìa khóa'))).toBe(false);
  });

  test('13. AUTHOR_SETUP clears stale chapters/control/state/memory/QA/cache across projects', () => {
    const parsed = parseSetupFileContent(`${makeSetup().split('[STORY_ENGINE_BLUEPRINT_V3]')[0]}[STORY_ENGINE_SETTINGS_V3]\n{"temperature":0.4}`);
    expect(parsed).not.toBeNull();
    const next = applySetupImport(makeCreativeState(), parsed!);
    expect(next.storyControl).toBeUndefined();
    expect(next.storyState).toBeUndefined();
    expect(next.memoryIndex).toBeUndefined();
    expect(next.lastValidationResult).toBeUndefined();
    expect(next.snapshots).toEqual([]);
    expect(next.chapters).toEqual([]);
  });

  test('14. FULL_PROJECT restores explicit derived state', () => {
    const blueprint = makeBlueprintRaw();
    const fullProject = JSON.stringify({
      importType: 'FULL_PROJECT',
      title: 'Project',
      characters: [{ id: 'hero', name: 'An' }],
      storyControl: { ...blueprint, sourceHash: 'saved_hash' },
      storyState: { ...makeStoryState(), currentChapter: 42, unresolvedThreads: ['Đang mở'] },
      memoryIndex: [{ chapterNumber: 42, title: 'C42', summary: 'S42', charactersInvolved: ['An'], locations: ['Thành'] }],
      chapters: [{ id: 'c42', title: 'C42', content: 'Text' }],
      lastValidationResult: {
        pass: true, continuityScore: 91, pacingScore: 88, violations: [],
        semanticChecks: {
          characterGating: true, worldFactContinuity: true, spoilerContainment: true,
          pacingIntegrity: true, characterTraitConsistency: true
        }
      }
    });
    const parsed = parseSetupFileContent(fullProject);
    expect(parsed?.importKind).toBe('FULL_PROJECT');
    const restored = applySetupImport(makeCreativeState(), parsed!);
    expect(restored.storyState?.currentChapter).toBe(42);
    expect(restored.memoryIndex?.[0].chapterNumber).toBe(42);
    expect(restored.storyControl?.arcs).toHaveLength(38);
    expect(restored.lastValidationResult?.continuityScore).toBe(91);
  });

  test('15. hash changes when future character appearance changes', () => {
    const first = validateBlueprintV3Object(makeBlueprintRaw());
    const changed = makeBlueprintRaw();
    changed.characterRegistry[1].appearance = 'Áo trắng';
    expect(computeBibleHash(makeBible(first))).not.toBe(computeBibleHash(makeBible(validateBlueprintV3Object(changed))));
  });

  test('16. hash changes when future character personality changes', () => {
    const first = validateBlueprintV3Object(makeBlueprintRaw());
    const changed = makeBlueprintRaw();
    changed.characterRegistry[1].personality = 'Nóng nảy';
    expect(computeBibleHash(makeBible(first))).not.toBe(computeBibleHash(makeBible(validateBlueprintV3Object(changed))));
  });

  test('17. hash changes when exposure rules change', () => {
    const first = validateBlueprintV3Object(makeBlueprintRaw());
    const changed = makeBlueprintRaw();
    changed.narrativeExposureRules[0].unlockChapter = 81;
    expect(computeBibleHash(makeBible(first))).not.toBe(computeBibleHash(makeBible(validateBlueprintV3Object(changed))));
  });

  test('18. schema mismatch invalidates stale StoryControl reuse', () => {
    const bible = makeBible();
    const hash = computeBibleHash(bible);
    const control = createDeterministicStoryControl(bible, hash, 600);
    expect(canReuseStoryControl(control, hash)).toBe(true);
    Reflect.set(control, 'schemaVersion', STORY_CONTROL_SCHEMA_VERSION - 1);
    expect(canReuseStoryControl(control, hash)).toBe(false);
  });

  test('19. resolvedThreads object entry cannot crash extractor', async () => {
    const result = await runExtractor(JSON.stringify({ resolvedThreads: [{ thread: 'X' }] }));
    expect(result.nextState.unresolvedThreads).toContain('Vấn đề cũ');
  });

  test('20. unresolvedThreads keeps only valid strings', async () => {
    const result = await runExtractor(JSON.stringify({ unresolvedThreads: ['valid', 123, null, { foo: 'bar' }] }));
    expect(result.nextState.unresolvedThreads).toContain('valid');
    expect(result.nextState.unresolvedThreads.some(thread => thread.includes('object Object'))).toBe(false);
  });

  test('21. newCharacters entry with object name is discarded', async () => {
    const result = await runExtractor(JSON.stringify({ newCharacters: [{ name: { value: 'X' } }] }));
    expect(result.newCharacters).toEqual([]);
  });

  test('22. malformed existing character names do not crash merge', async () => {
    const state = makeStoryState();
    const malformedCharacterState = {
      characterId: 'bad', name: { value: 'bad' }, location: null, physicalCondition: null,
      injuries: [], knownFacts: [], goals: []
    };
    Reflect.set(state.characterStates, 'bad', malformedCharacterState);
    const malformedExisting = makeBible().characters[0];
    Reflect.set(malformedExisting, 'name', { value: 'An' });
    const result = await runExtractor('{}', state, [malformedExisting]);
    expect(result.nextState.currentChapter).toBe(1);
  });

  test('23. invalid State Extractor JSON uses safe empty fallback', async () => {
    const parsed = parseStateDeltaResponse('not-json');
    expect(parsed.usedFallback).toBe(true);
    const result = await runExtractor('not-json');
    expect(result.nextState.unresolvedThreads).toEqual(['Vấn đề cũ']);
    expect(result.newCharacters).toEqual([]);
  });

  test('24. malformed optional nested delta preserves valid previous state', async () => {
    const state = makeStoryState();
    state.clues.push({
      id: 'old_clue', clue: 'Manh mối cũ', discoveredChapter: 1, discoveredBy: 'An',
      knownInterpretations: ['Hợp lệ'], actualTruthHidden: 'Bí mật', resolved: false
    });
    const result = await runExtractor(JSON.stringify({
      clues: [{ clue: { bad: true } }, { clue: 'Manh mối mới', interpretations: [1, 'hợp lệ'] }],
      relationships: [{ characterA: 'An', characterB: { bad: true } }],
      resources: { money: { bad: true }, equipment: ['kiếm', null] },
      chapterSummaries: [{ chapterNumber: 1, summary: { bad: true }, locations: ['Thành', 2] }]
    }), state);
    expect(result.nextState.clues.map(clue => clue.clue)).toEqual(['Manh mối cũ', 'Manh mối mới']);
    expect(result.nextState.resources.money).toBe('10');
    expect(result.newMemories[0].locations).toEqual(['Thành']);
  });

  test('25. invalid explicit Blueprint fails actionably and never falls back generic', () => {
    const invalid = makeBlueprintRaw();
    invalid.arcs[0].endChapter = 0;
    expect(() => parseBlueprintContent(`[STORY_ENGINE_BLUEPRINT_V3]\n${JSON.stringify(invalid)}`))
      .toThrow(/Blueprint V3 không hợp lệ.*range không hợp lệ/i);
  });
});
