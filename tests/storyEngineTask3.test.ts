import { describe, expect, test } from 'vitest';
import { buildRepairPrompt, buildSafeRepairRequest } from '../src/services/storyEngine/autoRepair';
import { createStoryControlFromBlueprint, validateBlueprintV3Object } from '../src/services/storyEngine/blueprintParser';
import { computeBibleHash } from '../src/services/storyEngine/compiler';
import { buildValidatorContext, createWriterView } from '../src/services/storyEngine/contextBuilder';
import { runStoryEnginePipeline } from '../src/services/storyEngine/pipeline';
import {
  parseSemanticValidationResponse,
  runSemanticValidation
} from '../src/services/storyEngine/semanticValidator';
import { validateBatchOutput } from '../src/services/storyEngine/validator';
import {
  BatchPlan,
  ChapterPlan,
  STORY_VIOLATION_TYPES,
  StoryBible,
  StoryControl,
  StoryState,
  StoryViolation
} from '../src/services/storyEngine/types';
import { CreativeChapter } from '../src/types';

const requiredTask3ViolationTypes = [
  'PREMATURE_EVIDENCE',
  'PREMATURE_INFERENCE',
  'READER_KNOWLEDGE_OVEREXPOSURE',
  'WORLD_FACT_GATE_VIOLATION',
  'MYSTERY_STAGE_VIOLATION',
  'PREMATURE_MYSTERY_RESOLUTION',
  'REAL_WORLD_CONTAMINATION',
  'ANACHRONISM',
  'CHRONOLOGY_CONTRADICTION',
  'LOCATION_CANON_CONTRADICTION',
  'CHARACTER_SKILL_DRIFT',
  'COMBAT_POWER_VIOLATION',
  'OPPONENT_COMPETENCE_FAILURE',
  'KNOWLEDGE_LEAK',
  'PLAN_VIOLATION',
  'ORIGINALITY_VIOLATION',
  'CLICHE_OVERUSE',
  'OUTPUT_STRUCTURE',
  'STATE_DELTA_INVALID',
  'QA_UNAVAILABLE'
] as const;

const bible: StoryBible = {
  seedTitle: 'Task 3 fixture',
  genre: 'Mystery',
  seriesPremise: 'A reader-safe investigation.',
  continuitySummary: '',
  worldNotes: '',
  charNotes: '',
  outline: '',
  characters: [{
    id: 'hero', name: 'Hero', gender: '', age: '', role: 'main',
    appearance: 'plain coat', personality: 'careful'
  }],
  totalPlannedChapters: 3
};

function makeControl(): StoryControl {
  const control = createStoryControlFromBlueprint(validateBlueprintV3Object({
    totalChapters: 3,
    settings: { readerSafePremise: 'A reader-safe investigation.', semanticQaTimeoutMs: 50 },
    characterRegistry: [{
      id: 'hero', name: 'Hero', role: 'main', appearance: 'plain coat', personality: 'careful',
      restrictions: [], unlockChapter: 1, directAppearanceChapter: 1, povUnlockChapter: 1,
      majorFocusNotBeforeChapter: 1
    }],
    worldFacts: [
      { id: 'public', fact: 'THE PUBLIC SKY IS BLUE', visibility: 'always', introducedAtChapter: 1 },
      {
        id: 'locked', fact: 'LOCKED FACT ALPHA', secretTruth: 'SECRET TRUTH BETA',
        visibility: 'gated', unlockChapter: 3
      }
    ],
    arcs: [{
      id: 'arc_1', title: 'Opening', startChapter: 1, endChapter: 3, climaxChapter: 3,
      theme: 'doubt', coreConflict: 'investigation', pacing: 'accelerating',
      unlockedCharacterIds: ['hero'], keyMilestones: [], worldBuildingFocus: '',
      forbiddenSpoilers: ['FUTURE ARC ANSWER']
    }],
    narrativeExposureRules: [{
      id: 'exposure_1', startChapter: 1, endChapter: 2,
      allowedEvidence: [], forbiddenEvidence: ['FORBIDDEN EVIDENCE'],
      allowedInferences: [], forbiddenInferences: ['FORBIDDEN INFERENCE'],
      readerKnowledgeCeiling: 'Only suspicion', relatedWorldFactIds: ['locked']
    }],
    mysteryThreads: [{
      id: 'mystery_1', question: 'Who?', actualTruth: 'MYSTERY TRUTH GAMMA',
      stages: [{ id: 'stage_1', startChapter: 1, endChapter: 2, allowedKnowledge: ['uncertainty'] }]
    }],
    spoilerGates: [{
      id: 'spoiler_1', description: 'FUTURE HIDDEN ANSWER', forbiddenBeforeChapter: 3,
      permittedArcs: ['arc_1'], relatedCharacters: []
    }],
    authorOnlySecrets: ['AUTHOR SECRET DELTA'],
    originality: { bannedPhrases: [] }
  }));
  control.sourceHash = computeBibleHash(bible);
  control.pacingRules.minWordsPerChapter = 1;
  return control;
}

function makeState(): StoryState {
  return {
    currentChapter: 0,
    characterStates: {},
    relationships: [],
    resources: {},
    clues: [],
    unresolvedThreads: [],
    longTermSeeds: [],
    recentConsequences: [],
    currentArcId: 'arc_1',
    currentArcProgress: 0,
    unlockedCharacterIds: ['hero'],
    worldFactStates: {}
  };
}

function chapterPlan(chapterNumber = 1): ChapterPlan {
  return {
    chapterNumber,
    arcId: 'arc_1',
    title: `Chapter ${chapterNumber}`,
    focus: 'Investigate carefully',
    primaryGoal: 'Investigate carefully',
    povCharacter: 'Hero',
    pacingTarget: 'rising_action',
    requiredEvents: [],
    introducedCharacters: [],
    activeCharacters: ['Hero'],
    worldFactInteractions: [],
    cluesDiscovered: [],
    forbiddenSpoilers: [],
    plannedCharacters: ['Hero'],
    plannedWorldFacts: [],
    plannedEvidence: [],
    plannedInferences: [],
    continuityRequirements: [],
    arcBeatIds: []
  };
}

function batchPlan(chapterNumber = 1): BatchPlan {
  return {
    arcId: 'arc_1',
    startChapter: chapterNumber,
    endChapter: chapterNumber,
    requestedChapterNumbers: [chapterNumber],
    chapters: [chapterPlan(chapterNumber)],
    batchDirectives: [],
    charactersGated: [],
    antiDriftMeasures: [],
    planValid: true
  };
}

function chapter(content = 'Safe chapter prose.', chapterNumber = 1): CreativeChapter {
  return { id: `chapter-${chapterNumber}`, chapterNumber, title: `Chapter ${chapterNumber}: Test`, content };
}

function xml(content = 'Safe chapter prose.', chapterNumber = 1): string {
  return `<CHAPTER number="${chapterNumber}" title="Chapter ${chapterNumber}: Test">${content}</CHAPTER>`;
}

function semanticJson(pass: boolean, violations: object[] = []): string {
  return JSON.stringify({ pass, violations });
}

function mediumViolation(type = 'PLAN_VIOLATION'): object {
  return {
    type,
    severity: 'MEDIUM',
    chapterNumber: 1,
    message: 'The approved primary goal was not completed.',
    evidence: 'short safe evidence',
    suggestedRepair: 'Restore the approved goal.'
  };
}

function plannerJson(): string {
  return JSON.stringify({ chapters: [chapterPlan()] });
}

describe('Story Engine Task 3 - semantic QA contract', () => {
  test('supports every required semantic violation class', () => {
    expect(STORY_VIOLATION_TYPES).toEqual(expect.arrayContaining([...requiredTask3ViolationTypes]));
  });

  test('parsed.pass=false fails even when violations is empty', async () => {
    const result = await runSemanticValidation('validator view', async () => semanticJson(false));
    expect(result).toMatchObject({ pass: false, status: 'FAIL', violations: [], attempts: 1 });
  });

  test('canonicalizes type and severity before applying the blocking policy', async () => {
    const result = await runSemanticValidation('validator view', async () => semanticJson(false, [{
      type: ' chronology_contradiction ', severity: ' medium ', message: 'Timeline conflict.'
    }]));
    expect(result.status).toBe('FAIL');
    expect(result.violations[0]).toMatchObject({ type: 'CHRONOLOGY_CONTRADICTION', severity: 'MEDIUM' });
  });

  test('HIGH and CRITICAL block while LOW remains advisory unless strict mode is enabled', async () => {
    const high = await runSemanticValidation('validator view', async () => semanticJson(true, [{
      type: 'KNOWLEDGE_LEAK', severity: 'HIGH', message: 'Unsupported knowledge.'
    }]));
    const critical = await runSemanticValidation('validator view', async () => semanticJson(true, [{
      type: 'COMBAT_POWER_VIOLATION', severity: 'CRITICAL', message: 'Impossible capability.'
    }]));
    const low = await runSemanticValidation('validator view', async () => semanticJson(true, [{
      type: 'CLICHE_OVERUSE', severity: 'LOW', message: 'Minor style concern.'
    }]));
    const strictLow = await runSemanticValidation('validator view', async () => semanticJson(true, [{
      type: 'CLICHE_OVERUSE', severity: 'LOW', message: 'Minor style concern.'
    }]), { strictLowSeverity: true });
    expect(high.status).toBe('FAIL');
    expect(critical.status).toBe('FAIL');
    expect(low).toMatchObject({ status: 'PASS', warnings: [{ severity: 'LOW' }] });
    expect(strictLow.status).toBe('FAIL');
  });

  test('invalid semantic JSON retries twice then returns QA_UNAVAILABLE', async () => {
    let calls = 0;
    const result = await runSemanticValidation('validator view', async () => {
      calls++;
      return 'not json';
    });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ pass: false, status: 'QA_UNAVAILABLE', attempts: 2 });
    expect(result.violations[0]).toMatchObject({ type: 'QA_UNAVAILABLE', severity: 'CRITICAL' });
    expect(Object.values(result.semanticChecks).every(value => value === false)).toBe(true);
  });

  test('model unavailable and timeout fail closed', async () => {
    const unavailable = await runSemanticValidation('validator view', undefined);
    let timeoutCalls = 0;
    const timedOut = await runSemanticValidation('validator view', async () => {
      timeoutCalls++;
      return await new Promise<string>(() => undefined);
    }, { timeoutMs: 2 });
    expect(unavailable).toMatchObject({ status: 'QA_UNAVAILABLE', attempts: 0 });
    expect(timedOut).toMatchObject({ status: 'QA_UNAVAILABLE', attempts: 2 });
    expect(timeoutCalls).toBe(2);
  });

  test('strict JSON parser rejects unsupported severity instead of downgrading it', () => {
    expect(() => parseSemanticValidationResponse(semanticJson(false, [{
      type: 'PLAN_VIOLATION', severity: 'warning', message: 'Bad severity.'
    }]))).toThrow(/severity/i);
  });
});

describe('Story Engine Task 3 - validator and repair isolation', () => {
  test('semantic QA receives the chapter-scoped Validator View while Writer View stays reader-safe', () => {
    const control = makeControl();
    const plan = batchPlan();
    const writer = JSON.stringify(createWriterView(bible, control, plan, makeState(), [], 1, []));
    const validator = buildValidatorContext(control, plan, makeState(), 1, [chapter()], []);
    expect(writer).not.toContain('MYSTERY TRUTH GAMMA');
    expect(writer).not.toContain('AUTHOR SECRET DELTA');
    expect(validator).toContain('MYSTERY TRUTH GAMMA');
    expect(validator).toContain('AUTHOR SECRET DELTA');
    expect(validator).toContain('Safe chapter prose.');
  });

  test('validator infrastructure exception becomes QA_UNAVAILABLE rather than pass or throw', async () => {
    const malformedPlan: BatchPlan = { ...batchPlan(), chapters: [] };
    const result = await validateBatchOutput(
      [chapter()], malformedPlan, makeControl(), makeState(), bible,
      async () => semanticJson(true)
    );
    expect(result).toMatchObject({ pass: false, status: 'QA_UNAVAILABLE' });
    expect(result.violations.some(violation => violation.type === 'QA_UNAVAILABLE')).toBe(true);
  });

  test('repair request and complete prompt redact every hidden-truth source case-insensitively', () => {
    const control = makeControl();
    const violation: StoryViolation = {
      type: 'CHRONOLOGY_CONTRADICTION', severity: 'MEDIUM', chapterNumber: 1,
      message: 'MYSTERY TRUTH GAMMA conflicts with AUTHOR SECRET DELTA.',
      evidence: 'locked fact alpha and future hidden answer',
      suggestedRepair: 'Use SECRET TRUTH BETA after FORBIDDEN EVIDENCE.'
    };
    const safeRequest = JSON.stringify(buildSafeRepairRequest([violation], control));
    const prompt = buildRepairPrompt(
      [chapter('The prose says mystery truth gamma, FUTURE ARC ANSWER, and forbidden inference.')],
      [violation],
      'Writer context accidentally contains author secret delta.',
      control
    );
    const combined = `${safeRequest}\n${prompt}`.toLocaleLowerCase('en-US');
    for (const secret of [
      'mystery truth gamma', 'author secret delta', 'locked fact alpha', 'secret truth beta',
      'future hidden answer', 'future arc answer', 'forbidden evidence', 'forbidden inference'
    ]) expect(combined).not.toContain(secret);
    expect(prompt).toContain('[HIDDEN_DETAIL]');
  });

  test('sensitive violation repair directions never echo semantic evidence', () => {
    const request = buildSafeRepairRequest([{
      type: 'PREMATURE_EVIDENCE', severity: 'HIGH', chapterNumber: 1,
      message: 'Hidden answer disclosed.', evidence: 'MYSTERY TRUTH GAMMA',
      suggestedRepair: 'Repeat MYSTERY TRUTH GAMMA more subtly.'
    }], makeControl());
    expect(request[0].evidence).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('MYSTERY TRUTH GAMMA');
  });
});

describe('Story Engine Task 3 - fail-closed repair pipeline', () => {
  test('semantic validation uses the quality runner, never the fast runner', async () => {
    let fastSemanticCalls = 0;
    let proSemanticCalls = 0;
    const result = await runStoryEnginePipeline({
      bible, existingControl: makeControl(), existingState: makeState(), existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction?.includes('semantic-validator')) fastSemanticCalls++;
        return systemInstruction?.includes('Chapter Planner') ? plannerJson() : '{}';
      },
      aiProRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction.includes('semantic-validator')) {
          proSemanticCalls++;
          return semanticJson(true);
        }
        return xml();
      }
    });
    expect(result.success).toBe(true);
    expect(result.acceptedChapters).toHaveLength(1);
    expect(proSemanticCalls).toBe(1);
    expect(fastSemanticCalls).toBe(0);
  });

  test('quality runner absence produces QA_UNAVAILABLE and no save', async () => {
    const result = await runStoryEnginePipeline({
      bible, existingControl: makeControl(), existingState: makeState(), existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => systemInstruction?.includes('Chapter Planner')
        ? plannerJson() : xml()
    });
    expect(result).toMatchObject({ success: false, acceptedChapters: [], newMemories: [], repairCount: 0 });
    expect(result.validationResult.status).toBe('QA_UNAVAILABLE');
  });

  test('parsed pass=false with no violations rejects atomically and is not repaired', async () => {
    const existingState = makeState();
    const stateBefore = JSON.stringify(existingState);
    let repairCalls = 0;
    const result = await runStoryEnginePipeline({
      bible, existingControl: makeControl(), existingState, existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => systemInstruction?.includes('Chapter Planner') ? plannerJson() : '{}',
      aiProRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction.includes('semantic-validator')) return semanticJson(false);
        if (systemInstruction.includes('repair writer')) repairCalls++;
        return xml();
      }
    });
    expect(result).toMatchObject({ success: false, acceptedChapters: [], newMemories: [], repairCount: 0 });
    expect(result.validationResult.status).toBe('FAIL');
    expect(repairCalls).toBe(0);
    expect(JSON.stringify(existingState)).toBe(stateBefore);
  });

  test('invalid semantic responses never enter repair and never save', async () => {
    let semanticCalls = 0;
    let repairCalls = 0;
    const result = await runStoryEnginePipeline({
      bible, existingControl: makeControl(), existingState: makeState(), existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => systemInstruction?.includes('Chapter Planner') ? plannerJson() : '{}',
      aiProRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction.includes('semantic-validator')) { semanticCalls++; return '{invalid'; }
        if (systemInstruction.includes('repair writer')) repairCalls++;
        return xml();
      }
    });
    expect(semanticCalls).toBe(2);
    expect(repairCalls).toBe(0);
    expect(result).toMatchObject({ success: false, acceptedChapters: [], newMemories: [], repairCount: 0 });
    expect(result.validationResult.status).toBe('QA_UNAVAILABLE');
  });

  test('performs at most two repairs and fully revalidates after each successful repair', async () => {
    let semanticCalls = 0;
    let repairCalls = 0;
    const semanticResponses = [
      semanticJson(false, [mediumViolation()]),
      semanticJson(false, [mediumViolation('KNOWLEDGE_LEAK')]),
      semanticJson(true)
    ];
    const result = await runStoryEnginePipeline({
      bible, existingControl: makeControl(), existingState: makeState(), existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => systemInstruction?.includes('Chapter Planner') ? plannerJson() : '{}',
      aiProRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction.includes('semantic-validator')) return semanticResponses[semanticCalls++];
        if (systemInstruction.includes('repair writer')) { repairCalls++; return xml(`Safe repair ${repairCalls}.`); }
        return xml('Initial prose.');
      }
    });
    expect(result.success).toBe(true);
    expect(result.repairCount).toBe(2);
    expect(repairCalls).toBe(2);
    expect(semanticCalls).toBe(3);
    expect(result.validationResult).toMatchObject({ status: 'PASS', repairAttempts: 2 });
  });

  test('deterministic checks rerun after repair before a semantic pass may be accepted', async () => {
    const control = makeControl();
    control.originality = { bannedPhrases: ['BANNED PHRASE'] };
    let semanticCalls = 0;
    let repairCalls = 0;
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: makeState(), existingChapters: [], batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => systemInstruction?.includes('Chapter Planner') ? plannerJson() : '{}',
      aiProRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction.includes('semantic-validator')) {
          semanticCalls++;
          return semanticCalls === 1 ? semanticJson(false, [mediumViolation()]) : semanticJson(true);
        }
        if (systemInstruction.includes('repair writer')) {
          repairCalls++;
          return repairCalls === 1 ? xml('This contains BANNED PHRASE.') : xml('Safe final repair.');
        }
        return xml('Initial prose.');
      }
    });
    expect(result.success).toBe(true);
    expect(result.repairCount).toBe(2);
    expect(repairCalls).toBe(2);
    expect(semanticCalls).toBe(3);
    expect(result.acceptedChapters[0].content).toBe('Safe final repair.');
  });

  test('still failing after Repair 2 returns no accepted chapters or derived state', async () => {
    const existingChapters: CreativeChapter[] = [chapter('Already saved.', 1)];
    const existingState = { ...makeState(), currentChapter: 1 };
    const chaptersBefore = JSON.stringify(existingChapters);
    const stateBefore = JSON.stringify(existingState);
    let semanticCalls = 0;
    let repairCalls = 0;
    const result = await runStoryEnginePipeline({
      bible,
      existingControl: makeControl(),
      existingState,
      existingChapters,
      batchSize: 1,
      aiFastRunner: async (_prompt, systemInstruction) => systemInstruction?.includes('Chapter Planner')
        ? JSON.stringify({ chapters: [chapterPlan(2)] }) : '{}',
      aiProRunner: async (_prompt, systemInstruction) => {
        if (systemInstruction.includes('semantic-validator')) {
          semanticCalls++;
          return semanticJson(false, [{ ...mediumViolation(), chapterNumber: 2 }]);
        }
        if (systemInstruction.includes('repair writer')) { repairCalls++; return xml(`Still invalid ${repairCalls}.`, 2); }
        return xml('Initial chapter two.', 2);
      }
    });
    expect(result).toMatchObject({ success: false, acceptedChapters: [], newMemories: [], repairCount: 2 });
    expect(semanticCalls).toBe(3);
    expect(repairCalls).toBe(2);
    expect(JSON.stringify(existingChapters)).toBe(chaptersBefore);
    expect(JSON.stringify(existingState)).toBe(stateBefore);
  });
});
