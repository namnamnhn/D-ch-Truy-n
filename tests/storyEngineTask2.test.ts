import { describe, expect, test } from 'vitest';
import { createStoryControlFromBlueprint, validateBlueprintV3Object } from '../src/services/storyEngine/blueprintParser';
import { computeBibleHash } from '../src/services/storyEngine/compiler';
import { createPlannerView, createValidatorView, createWriterView } from '../src/services/storyEngine/contextBuilder';
import { createDeterministicBatchPlan, generateBatchPlan } from '../src/services/storyEngine/planner';
import { validateBatchPlan } from '../src/services/storyEngine/planValidator';
import { runStoryEnginePipeline } from '../src/services/storyEngine/pipeline';
import {
  getActiveExposureRules,
  getArcForChapter,
  getCharacterAccess,
  getStoryEngineSanityInfo,
  splitChaptersByArc
} from '../src/services/storyEngine/storyAccess';
import { validateWriterOutput, WriterOutputValidationError } from '../src/services/storyEngine/writer';
import { BatchPlan, ChapterPlan, StoryBible, StoryControl, StoryState } from '../src/services/storyEngine/types';
import { CreativeChapter } from '../src/types';

const longProse = Array.from({ length: 2005 }, (_, index) => `từ${index}`).join(' ');

function makeControl(): StoryControl {
  return createStoryControlFromBlueprint(validateBlueprintV3Object({
    totalChapters: 30,
    settings: { readerSafePremise: 'Tiền đề an toàn cho độc giả.' },
    characterRegistry: [
      {
        id: 'hero', name: 'Hero', aliases: ['H'], role: 'main', appearance: 'áo xanh', personality: 'bình tĩnh',
        restrictions: [], unlockChapter: 1, directAppearanceChapter: 1, povUnlockChapter: 1, majorFocusNotBeforeChapter: 1
      },
      {
        id: 'future', name: 'Future Character', aliases: ['FC'], role: 'future',
        appearance: 'FUTURE_CHARACTER_SECRET_Q4Z1', personality: 'hồ sơ tương lai', restrictions: ['không lộ'],
        unlockChapter: 5, directAppearanceChapter: 7, povUnlockChapter: 8, majorFocusNotBeforeChapter: 10
      }
    ],
    worldFacts: [
      { id: 'public', fact: 'Bầu trời màu xanh', visibility: 'always', introducedAtChapter: 1 },
      { id: 'gated', fact: 'LOCKED_WORLD_FACT_SECRET_P8M2', visibility: 'gated', unlockChapter: 6 },
      { id: 'author', fact: 'AUTHOR_FACT_ONLY', visibility: 'author_only', introducedAtChapter: 1 }
    ],
    arcs: [
      {
        id: 'arc_a', title: 'Arc A', startChapter: 1, endChapter: 18, climaxChapter: 17,
        theme: 'A', coreConflict: 'Conflict A', pacing: 'accelerating', unlockedCharacterIds: ['hero'],
        keyMilestones: ['A_CURRENT_BEAT'], worldBuildingFocus: 'A world', forbiddenSpoilers: []
      },
      {
        id: 'arc_b', title: 'Arc B', startChapter: 19, endChapter: 30, climaxChapter: 28,
        theme: 'B', coreConflict: 'Conflict B', pacing: 'high_stakes', unlockedCharacterIds: ['hero', 'future'],
        keyMilestones: ['B_FUTURE_BEAT'], worldBuildingFocus: 'B world', forbiddenSpoilers: []
      }
    ],
    narrativeExposureRules: [
      {
        id: 'rule_one', startChapter: 1, endChapter: 9,
        allowedEvidence: ['safe clue'], forbiddenEvidence: ['forbidden clue'],
        allowedInferences: ['safe inference'], forbiddenInferences: ['forbidden inference'],
        readerKnowledgeCeiling: 'Chưa biết thủ phạm', relatedWorldFactIds: ['public']
      },
      {
        id: 'rule_two', startChapter: 6, endChapter: 12,
        allowedEvidence: ['second clue'], forbiddenEvidence: ['second forbidden'],
        allowedInferences: [], forbiddenInferences: [], readerKnowledgeCeiling: 'Chỉ nghi ngờ', relatedWorldFactIds: ['gated']
      }
    ],
    mysteryThreads: [{
      id: 'mystery', question: 'Ai làm?', actualTruth: 'MYSTERY_TRUTH_SECRET_A7C3',
      stages: [
        { id: 'stage_early', startChapter: 1, endChapter: 9, allowedKnowledge: ['Có dấu vết'] },
        { id: 'stage_late', startChapter: 10, endChapter: 20, allowedKnowledge: ['Có nghi phạm'] }
      ]
    }],
    authorOnlySecrets: ['AUTHOR_SECRET_X9K7'],
    characterGates: [], spoilerGates: [], originality: { avoid: ['copy'] }
  }));
}

const bible: StoryBible = {
  seedTitle: 'Test Story', genre: 'Mystery',
  seriesPremise: 'FULL_FUTURE_OUTLINE_SECRET_Z1', continuitySummary: 'reader prior',
  worldNotes: 'future world notes', charNotes: 'future char notes', outline: 'FULL_OUTLINE_SECRET_Z2',
  characters: [
    { id: 'hero', name: 'Hero', gender: '', age: '', role: 'main', appearance: 'áo xanh', personality: 'bình tĩnh' },
    { id: 'future', name: 'Future Character', gender: '', age: '', role: 'future', appearance: 'FUTURE_CHARACTER_SECRET_Q4Z1', personality: 'future' }
  ], totalPlannedChapters: 30
};

function makeState(currentChapter = 0): StoryState {
  return {
    currentChapter, characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [],
    longTermSeeds: [], recentConsequences: [], currentArcId: currentChapter >= 19 ? 'arc_b' : 'arc_a',
    currentArcProgress: 0, unlockedCharacterIds: ['hero'], worldFactStates: {}
  };
}

function chapterPlan(chapterNumber: number, patch: Partial<ChapterPlan> = {}): ChapterPlan {
  return {
    chapterNumber, arcId: chapterNumber <= 18 ? 'arc_a' : 'arc_b', title: `Chương ${chapterNumber}`,
    focus: 'Tiến triển hiện tại', primaryGoal: 'Tiến triển hiện tại', povCharacter: 'Hero',
    pacingTarget: 'rising_action', requiredEvents: [], introducedCharacters: [], activeCharacters: ['Hero'],
    worldFactInteractions: [], cluesDiscovered: [], forbiddenSpoilers: [], plannedCharacters: ['Hero'],
    plannedWorldFacts: [], plannedEvidence: [], plannedInferences: [], continuityRequirements: [], arcBeatIds: [],
    ...patch
  };
}

function batch(chapters: ChapterPlan[]): BatchPlan {
  const numbers = chapters.map(chapter => chapter.chapterNumber);
  return {
    arcId: chapters.length && chapters.every(chapter => chapter.arcId === chapters[0].arcId)
      ? chapters[0].arcId || '' : 'multi',
    startChapter: numbers[0], endChapter: numbers[numbers.length - 1], requestedChapterNumbers: numbers,
    chapters, batchDirectives: [], charactersGated: [], antiDriftMeasures: [], planValid: true
  };
}

function views(chapter: number) {
  const control = makeControl();
  const plan = batch([chapterPlan(chapter)]);
  const state = makeState(chapter - 1);
  return {
    planner: createPlannerView(bible, control, state, [], chapter, []),
    writer: createWriterView(bible, control, plan, state, [], chapter, []),
    validator: createValidatorView(control, plan, state, chapter)
  };
}

function validPlannerJson(chapter: number): string {
  return JSON.stringify({ chapters: [chapterPlan(chapter)] });
}

function xml(chapter: number, content = longProse): string {
  return `<CHAPTER number="${chapter}" title="Chương ${chapter}: Test">${content}</CHAPTER>`;
}

describe('Story Engine Task 2 - context isolation and planning contracts', () => {
  test('1. locked character absent from Planner View', () => expect(JSON.stringify(views(4).planner)).not.toContain('Future Character'));
  test('2. locked character absent from Writer View', () => expect(JSON.stringify(views(4).writer)).not.toContain('Future Character'));
  test('3. locked character remains in Validator View', () => expect(JSON.stringify(views(4).validator)).toContain('Future Character'));
  test('4. character appears exactly at unlockChapter', () => {
    expect(JSON.stringify(views(4).planner)).not.toContain('Future Character');
    expect(JSON.stringify(views(5).planner)).toContain('Future Character');
  });
  test('5. full profile does not leak before directAppearanceChapter', () => {
    const serialized = JSON.stringify(views(6).writer);
    expect(serialized).toContain('Future Character');
    expect(serialized).not.toContain('FUTURE_CHARACTER_SECRET_Q4Z1');
  });
  test('6. direct appearance allowed at correct gate', () => {
    const control = makeControl();
    expect(getCharacterAccess(control, control.characterRegistry.future, 6).canAppearDirectly).toBe(false);
    expect(getCharacterAccess(control, control.characterRegistry.future, 7).canAppearDirectly).toBe(true);
  });
  test('7. POV before povUnlockChapter is rejected', () => {
    const result = validateBatchPlan(batch([chapterPlan(7, { povCharacter: 'Future Character' })]), makeControl(), makeState(), [7]);
    expect(result.violations.some(violation => violation.code === 'POV_LOCKED')).toBe(true);
  });
  test('8. POV at gate passes', () => {
    const result = validateBatchPlan(batch([chapterPlan(8, { povCharacter: 'Future Character', activeCharacters: ['Future Character'] })]), makeControl(), makeState(), [8]);
    expect(result.violations.some(violation => violation.code === 'POV_LOCKED')).toBe(false);
  });
  test('9. major focus before gate fails', () => {
    const result = validateBatchPlan(batch([chapterPlan(9, { majorFocusCharacter: 'Future Character' })]), makeControl(), makeState(), [9]);
    expect(result.violations.some(violation => violation.code === 'MAJOR_FOCUS_LOCKED')).toBe(true);
  });
  test('10. gated WorldFact absent before gate', () => expect(views(5).planner.worldFacts.map(fact => fact.id)).not.toContain('gated'));
  test('11. gated WorldFact present at gate', () => expect(views(6).planner.worldFacts.map(fact => fact.id)).toContain('gated'));
  test('12. author_only WorldFact absent from Planner', () => expect(views(6).planner.worldFacts.map(fact => fact.id)).not.toContain('author'));
  test('13. author_only WorldFact absent from Writer', () => expect(views(6).writer.worldFacts.map(fact => fact.id)).not.toContain('author'));
  test('14. author_only WorldFact present in Validator', () => expect(JSON.stringify(views(6).validator)).toContain('AUTHOR_FACT_ONLY'));
  test('15. mystery actualTruth absent from Planner', () => expect(JSON.stringify(views(6).planner)).not.toContain('MYSTERY_TRUTH_SECRET_A7C3'));
  test('16. mystery actualTruth absent from Writer', () => expect(JSON.stringify(views(6).writer)).not.toContain('MYSTERY_TRUTH_SECRET_A7C3'));
  test('17. mystery actualTruth present in Validator', () => expect(JSON.stringify(views(6).validator)).toContain('MYSTERY_TRUTH_SECRET_A7C3'));
  test('18. correct exposure rule active by chapter', () => expect(getActiveExposureRules(makeControl(), 3).map(rule => rule.id)).toEqual(['rule_one']));
  test('19. overlapping exposure rules are both retained', () => expect(getActiveExposureRules(makeControl(), 7).map(rule => rule.id)).toEqual(['rule_one', 'rule_two']));
  test('20. forbidden explicit evidence rejects plan', () => {
    const result = validateBatchPlan(batch([chapterPlan(7, { plannedEvidence: ['forbidden clue'] })]), makeControl(), makeState(), [7]);
    expect(result.violations.some(violation => violation.code === 'FORBIDDEN_EVIDENCE')).toBe(true);
  });
  test('21. forbidden explicit inference rejects plan', () => {
    const result = validateBatchPlan(batch([chapterPlan(7, { plannedInferences: ['forbidden inference'] })]), makeControl(), makeState(), [7]);
    expect(result.violations.some(violation => violation.code === 'FORBIDDEN_INFERENCE')).toBe(true);
  });
  test('22. locked world fact rejects plan', () => {
    const result = validateBatchPlan(batch([chapterPlan(5, { plannedWorldFacts: ['gated'] })]), makeControl(), makeState(), [5]);
    expect(result.violations.some(violation => violation.code === 'WORLD_FACT_LOCKED')).toBe(true);
  });
  test('23. future arc beat rejects plan', () => {
    const result = validateBatchPlan(batch([chapterPlan(18, { arcBeatIds: ['arc_b:B_FUTURE_BEAT'] })]), makeControl(), makeState(), [18]);
    expect(result.violations.some(violation => violation.code === 'FUTURE_ARC_BEAT')).toBe(true);
  });
  test('24. invalid plan triggers replan', async () => {
    let calls = 0;
    const result = await generateBatchPlan(bible, makeControl(), makeState(), [], 7, 1, [], async () => {
      calls++;
      return calls === 1 ? validPlannerJson(7).replace('"Hero"', '"Future Character"') : validPlannerJson(7);
    });
    expect(calls).toBe(2);
    expect(result.planValid).toBe(true);
  });
  test('25. after two replan failures Writer is not called', async () => {
    const control = makeControl();
    control.sourceHash = computeBibleHash(bible);
    let writerCalls = 0;
    const existing = Array.from({ length: 6 }, (_, index): CreativeChapter => ({ id: `c${index}`, title: `Chương ${index + 1}`, content: 'old' }));
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: makeState(6), existingChapters: existing, batchSize: 1,
      aiFastRunner: async () => JSON.stringify({ chapters: [chapterPlan(7, { povCharacter: 'Future Character' })] }),
      aiProRunner: async () => { writerCalls++; return xml(7); }
    });
    expect(result.success).toBe(false);
    expect(writerCalls).toBe(0);
  });
  test('26. valid plan calls Writer', async () => {
    const control = makeControl(); control.sourceHash = computeBibleHash(bible);
    let writerCalls = 0;
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: makeState(), existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, sys) => sys?.includes('Chapter Planner') ? validPlannerJson(1) : '{}',
      aiProRunner: async (_prompt, sys) => {
        if (sys?.includes('semantic plan validator')) return JSON.stringify({ pass: true, violations: [] });
        if (sys?.includes('semantic-validator')) return JSON.stringify({ pass: true, violations: [] });
        writerCalls++;
        return xml(1);
      }
    });
    expect(writerCalls).toBeGreaterThan(0);
    expect(result.acceptedChapters).toHaveLength(1);
  });
  test('27. Ch18 and Ch19 resolve to their exact arcs', () => {
    expect(views(18).writer.arc.id).toBe('arc_a');
    expect(views(19).writer.arc.id).toBe('arc_b');
  });
  test('28. batch 16-20 splits at arc boundary', () => {
    expect(splitChaptersByArc(makeControl(), [16, 17, 18, 19, 20]).map(segment => segment.chapterNumbers))
      .toEqual([[16, 17, 18], [19, 20]]);
  });
  test('29. final batch position does not force cliffhanger', () => {
    const control = makeControl();
    const alone = createDeterministicBatchPlan(bible, control, [16]).chapters[0].pacingTarget;
    const inBatch = createDeterministicBatchPlan(bible, control, [15, 16]).chapters[1].pacingTarget;
    expect(inBatch).toBe(alone);
    expect(inBatch).not.toBe('cliffhanger');
  });
  test('30. request 2 chapters but Writer returns 1 fails', () => expect(() => validateWriterOutput(xml(7), [7, 8])).toThrow(WriterOutputValidationError));
  test('31. request 2 chapters but Writer returns 3 fails', () => expect(() => validateWriterOutput(xml(7) + xml(8) + xml(9), [7, 8])).toThrow(WriterOutputValidationError));
  test('32. duplicate chapter number fails', () => expect(() => validateWriterOutput(xml(7) + xml(7), [7, 8])).toThrow(WriterOutputValidationError));
  test('33. wrong chapter numbers fail', () => expect(() => validateWriterOutput(xml(9) + xml(10), [7, 8])).toThrow(WriterOutputValidationError));
  test('34. empty chapter fails', () => expect(() => validateWriterOutput(xml(7, '   '), [7])).toThrow(WriterOutputValidationError));
  test('35. malformed metadata/control output fails', () => expect(() => validateWriterOutput(xml(7) + '<CONTROL>secret</CONTROL>', [7])).toThrow(WriterOutputValidationError));
  test('36. partial Writer failure does not mutate or accept batch', async () => {
    const control = makeControl(); control.sourceHash = computeBibleHash(bible);
    const existing = Array.from({ length: 16 }, (_, index): CreativeChapter => ({ id: `c${index}`, title: `Chương ${index + 1}`, content: 'old' }));
    const original = JSON.stringify(existing);
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: makeState(16), existingChapters: existing, batchSize: 2,
      aiFastRunner: async (_prompt, sys) => {
        const match = sys?.match(/\[(\d+)\]/); const chapter = Number(match?.[1] || 17);
        return sys?.includes('Chapter Planner') ? validPlannerJson(chapter) : '{}';
      },
      aiProRunner: async (_prompt, sys) => {
        if (sys.includes('semantic plan validator')) return JSON.stringify({ pass: true, violations: [] });
        return sys.includes('[17]') ? xml(17) : xml(19);
      }
    });
    expect(result.success).toBe(false);
    expect(result.acceptedChapters).toEqual([]);
    expect(JSON.stringify(existing)).toBe(original);
  });
  test('37. full future outline absent from Writer View', () => {
    const serialized = JSON.stringify(views(6).writer);
    expect(serialized).not.toContain('FULL_FUTURE_OUTLINE_SECRET_Z1');
    expect(serialized).not.toContain('FULL_OUTLINE_SECRET_Z2');
  });
  test('38. future registry profile absent from Writer prompt projection', () => expect(JSON.stringify(views(6).writer)).not.toContain('FUTURE_CHARACTER_SECRET_Q4Z1'));
  test('39. reader-safe current arc context remains available', () => {
    const view = views(6).writer;
    expect(view.arc.id).toBe('arc_a');
    expect(view.arc.keyMilestones).toContain('A_CURRENT_BEAT');
    expect(view.readerSafePremise).toBe('Tiền đề an toàn cho độc giả.');
    expect(getStoryEngineSanityInfo(makeControl(), 6)).toMatchObject({ chapter: 6, arcId: 'arc_a', activeExposureRuleIds: ['rule_one', 'rule_two'] });
  });
  test('40. authoritative 38-arc Blueprint preserves all exact ranges', () => {
    const arcs = Array.from({ length: 38 }, (_, index) => ({
      id: `arc_${index + 1}`, title: `Arc ${index + 1}`, startChapter: index * 10 + 1, endChapter: index * 10 + 10
    }));
    const control = createStoryControlFromBlueprint(validateBlueprintV3Object({ arcs }));
    expect(control.arcs.map(arc => [arc.startChapter, arc.endChapter])).toEqual(arcs.map(arc => [arc.startChapter, arc.endChapter]));
  });

  test('security leak fixture is absent from Planner/Writer and present in Validator', () => {
    const projected = views(4);
    const planner = JSON.stringify(projected.planner);
    const writer = JSON.stringify(projected.writer);
    const validator = JSON.stringify(projected.validator);
    for (const secret of ['AUTHOR_SECRET_X9K7', 'FUTURE_CHARACTER_SECRET_Q4Z1', 'LOCKED_WORLD_FACT_SECRET_P8M2', 'MYSTERY_TRUTH_SECRET_A7C3']) {
      expect(planner).not.toContain(secret);
      expect(writer).not.toContain(secret);
      expect(validator).toContain(secret);
    }
  });

  test('direct appearance before its gate is rejected by production Plan Validator', () => {
    const result = validateBatchPlan(batch([chapterPlan(6, { activeCharacters: ['Future Character'] })]), makeControl(), makeState(), [6]);
    expect(result.violations.some(violation => violation.code === 'DIRECT_APPEARANCE_LOCKED')).toBe(true);
  });

  test('author_only WorldFact is rejected by production Plan Validator', () => {
    const result = validateBatchPlan(batch([chapterPlan(7, { plannedWorldFacts: ['author'] })]), makeControl(), makeState(), [7]);
    expect(result.violations.some(violation => violation.code === 'WORLD_FACT_AUTHOR_ONLY')).toBe(true);
  });

  test('future mystery stage is rejected by production Plan Validator', () => {
    const result = validateBatchPlan(batch([chapterPlan(8, { mysteryStageId: 'stage_late' })]), makeControl(), makeState(), [8]);
    expect(result.violations.some(violation => violation.code === 'MYSTERY_STAGE_LOCKED')).toBe(true);
  });

  test('chapter arcId mismatch is rejected by production Plan Validator', () => {
    const result = validateBatchPlan(batch([chapterPlan(18, { arcId: 'arc_b' })]), makeControl(), makeState(), [18]);
    expect(result.violations.some(violation => violation.code === 'ARC_MISMATCH')).toBe(true);
  });
});
