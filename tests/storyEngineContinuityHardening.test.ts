import { describe, expect, test } from 'vitest';
import { buildRepairPrompt, buildSafeRepairRequest } from '../src/services/storyEngine/autoRepair';
import { createStoryControlFromBlueprint, validateBlueprintV3Object } from '../src/services/storyEngine/blueprintParser';
import { computeBibleHash } from '../src/services/storyEngine/compiler';
import { buildWriterContext } from '../src/services/storyEngine/contextBuilder';
import {
  createEmptyInBatchContinuityLock,
  extendInBatchContinuityLock,
  extractConcreteFacts
} from '../src/services/storyEngine/continuityLock';
import { formatSemanticQaDiagnosticLines } from '../src/services/storyEngine/diagnostics';
import {
  createOutputLanguageContract,
  findUnexpectedScriptContamination
} from '../src/services/storyEngine/languageContract';
import {
  getStoryModelCandidates,
  isStoryModelAllowedForRole,
  runApprovedStoryModelCandidates,
  StoryModelPolicy
} from '../src/services/storyEngine/modelRouting';
import { runStoryEnginePipeline } from '../src/services/storyEngine/pipeline';
import {
  buildSemanticValidatorSystemPrompt,
  canonicalizeStoryValidation,
  parseSemanticValidationResponse,
  runSemanticValidation
} from '../src/services/storyEngine/semanticValidator';
import { validateDeterministicBatchOutput } from '../src/services/storyEngine/validator';
import {
  generateChaptersProse,
  MAX_WRITER_ATTEMPTS,
  validateWriterOutput,
  WriterOutputValidationError
} from '../src/services/storyEngine/writer';
import {
  BatchPlan,
  ChapterPlan,
  STORY_STATE_SCHEMA_VERSION,
  StoryBible,
  StoryControl,
  StoryState,
  StoryViolation
} from '../src/services/storyEngine/types';
import { CreativeChapter } from '../src/types';

function fixture(strictLanguage = false): { bible: StoryBible; control: StoryControl; state: StoryState } {
  const bible: StoryBible = {
    seedTitle: 'Continuity fixture', genre: 'Mystery', seriesPremise: 'A safe investigation.',
    continuitySummary: '', worldNotes: '', charNotes: '', outline: '', characters: [{
      id: 'hero', name: 'Lan', gender: '', age: '', role: 'investigator', appearance: '', personality: 'careful'
    }], totalPlannedChapters: 3,
    storyEngineSettingsV3: {
      outputLanguage: 'Vietnamese', strictOutputLanguage: strictLanguage,
      allowedForeignTerms: ['API', 'Atlas Ω']
    }
  };
  const blueprint = validateBlueprintV3Object({
    totalChapters: 3,
    settings: bible.storyEngineSettingsV3,
    characterRegistry: [{
      id: 'hero', name: 'Lan', aliasSet: ['Лан Canon'], role: 'investigator', appearance: '', personality: 'careful',
      restrictions: [], unlockChapter: 1, directAppearanceChapter: 1, povUnlockChapter: 1, majorFocusNotBeforeChapter: 1
    }],
    worldFacts: [],
    arcs: [{
      id: 'arc', title: 'Opening', startChapter: 1, endChapter: 3, climaxChapter: 3,
      theme: 'evidence', coreConflict: 'investigate', pacing: 'accelerating',
      unlockedCharacterIds: ['hero'], keyMilestones: [], worldBuildingFocus: '', forbiddenSpoilers: []
    }],
    narrativeExposureRules: [], mysteryThreads: [], authorOnlySecrets: ['AUTHOR_SECRET_CONTINUITY_X']
  });
  const control = createStoryControlFromBlueprint(blueprint, computeBibleHash(bible), bible.storyEngineSettingsV3);
  control.pacingRules.minWordsPerChapter = 1;
  control.pacingRules.maxWordsPerChapter = 10_000;
  const state: StoryState = {
    schemaVersion: STORY_STATE_SCHEMA_VERSION, sourceHash: control.sourceHash, currentChapter: 0,
    characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [],
    longTermSeeds: [], recentConsequences: [], currentArcId: 'arc', currentArcProgress: 0,
    unlockedCharacterIds: ['hero'], worldFactStates: {}
  };
  return { bible, control, state };
}

function plan(chapterNumber: number, cluesDiscovered: string[] = []): ChapterPlan {
  return {
    chapterNumber, arcId: 'arc', title: `Chapter ${chapterNumber}`, focus: 'Continue the approved investigation.',
    primaryGoal: 'Continue the approved investigation.', povCharacter: 'Lan', pacingTarget: 'rising_action',
    requiredEvents: [], introducedCharacters: [], activeCharacters: ['Lan'], worldFactInteractions: [],
    cluesDiscovered, forbiddenSpoilers: [], plannedCharacters: ['Lan'], plannedWorldFacts: [],
    plannedEvidence: [], plannedInferences: [], continuityRequirements: [], arcBeatIds: []
  };
}

function batch(chapters: ChapterPlan[]): BatchPlan {
  return {
    arcId: 'arc', startChapter: chapters[0].chapterNumber, endChapter: chapters[chapters.length - 1].chapterNumber,
    requestedChapterNumbers: chapters.map(item => item.chapterNumber), chapters,
    batchDirectives: [], charactersGated: [], antiDriftMeasures: [], planValid: true
  };
}

function chapter(chapterNumber: number, content: string): CreativeChapter {
  return { id: `chapter_${chapterNumber}`, chapterNumber, title: `Chapter ${chapterNumber}: Test`, content, status: 'completed' };
}

function xml(chapterNumber: number, content: string): string {
  return `<CHAPTER number="${chapterNumber}" title="Chapter ${chapterNumber}: Test">${content}</CHAPTER>`;
}

function semantic(pass: boolean, type?: string, chapterNumber = 2): string {
  return JSON.stringify({
    pass,
    violations: type ? [{ type, severity: 'HIGH', chapterNumber, message: `Detected ${type}.`, evidence: 'safe evidence' }] : []
  });
}

async function runPipeline(options: {
  prose?: Record<number, string>;
  semanticResponses?: string[];
  repairResponses?: string[];
  clues?: Record<number, string[]>;
  count?: number;
  semanticRunner?: () => Promise<string>;
} = {}) {
  const { bible, control, state } = fixture();
  const prompts = { writer: [] as string[], repair: [] as string[] };
  let semanticIndex = 0;
  let repairIndex = 0;
  const count = options.count || 2;
  const fast = async (_prompt: string, systemInstruction = '') => {
    if (systemInstruction.includes('Chapter Planner')) {
      const number = Number(systemInstruction.match(/\[(\d+)\]/)?.[1] || 1);
      return JSON.stringify({ chapters: [plan(number, options.clues?.[number] || [])] });
    }
    return '{}';
  };
  const quality = async (promptText: string, systemInstruction = '') => {
    if (systemInstruction.includes('semantic plan validator')) return JSON.stringify({ pass: true, violations: [] });
    const number = Number(systemInstruction.match(/\[(\d+)\]/)?.[1] || 1);
    if (systemInstruction.includes('repair writer')) {
      prompts.repair.push(promptText);
      return options.repairResponses?.[repairIndex++] || xml(number, `safe repaired prose ${number}`);
    }
    prompts.writer.push(promptText);
    return xml(number, options.prose?.[number] || `safe prose ${number}`);
  };
  const result = await runStoryEnginePipeline({
    bible, existingControl: control, existingState: state, existingChapters: [], batchSize: count,
    aiFastRunner: fast, aiProRunner: quality,
    aiSemanticRunner: options.semanticRunner || (async () => options.semanticResponses?.[semanticIndex++] || semantic(true))
  });
  return { result, prompts, state, control, bible };
}

describe('Writer continuity hardening - language contract and deterministic scripts', () => {
  test('1. Vietnamese strict Writer context includes an explicit target-language contract', () => {
    const { bible, control, state } = fixture(true);
    const context = buildWriterContext(bible, control, batch([plan(1)]), state, [], 1, 1, []);
    expect(context).toContain('[OUTPUT LANGUAGE CONTRACT]');
    expect(context).toContain('Prose language: Vietnamese');
    expect(context).toContain('Do not code-switch');
  });

  test('2. unexpected Cyrillic fragment gets a deterministic contamination finding', () => {
    const { bible, control } = fixture(true);
    expect(findUnexpectedScriptContamination('Khuôn mặt gã мгновенно tái dại.', createOutputLanguageContract(control, bible)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ script: 'CYRILLIC', fragment: 'мгновенно' })]));
  });

  test('3. unexpected Han fragment outside the allowlist gets a finding', () => {
    const { bible, control } = fixture(true);
    expect(findUnexpectedScriptContamination('Bố chính ty规定 điều đó.', createOutputLanguageContract(control, bible)))
      .toEqual(expect.arrayContaining([expect.objectContaining({ script: 'HAN', fragment: '规定' })]));
  });

  test('4. canonical allowlisted foreign proper noun does not false-positive', () => {
    const { bible, control } = fixture(true);
    expect(findUnexpectedScriptContamination('Лан Canon bước vào.', createOutputLanguageContract(control, bible))).toEqual([]);
  });

  test('5. explicitly allowed foreign terminology does not false-positive', () => {
    const { bible, control } = fixture(true);
    control.settings = { ...(control.settings || {}), allowedForeignTerms: ['术语'] };
    expect(findUnexpectedScriptContamination('Anh dùng 术语 đã được duyệt.', createOutputLanguageContract(control, bible))).toEqual([]);
  });
});

describe('Writer continuity hardening - concrete facts and discoveries', () => {
  test('6. chapter N establishes a generic object quantity', () => {
    expect(extractConcreteFacts('The survey token weighed 5 units.', 1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: 'survey token', value: '5', unit: 'units', established: true })
    ]));
  });

  test('7. chapter N+1 Writer receives the exact established quantity in its lock', async () => {
    const run = await runPipeline({ prose: { 1: 'The survey token weighed 5 units.', 2: 'Lan stored the survey token.' } });
    expect(run.prompts.writer[1]).toContain('survey token');
    expect(run.prompts.writer[1]).toContain('"value": "5"');
    expect(run.prompts.writer[1]).toContain('"established": true');
  });

  test('8. contradictory later quantity becomes FACT_CONTRADICTION', () => {
    const { bible, control, state } = fixture();
    const result = validateDeterministicBatchOutput([
      chapter(1, 'The survey token weighed 5 units.'),
      chapter(2, 'The survey token weighed 10 units.')
    ], batch([plan(1), plan(2)]), control, state, bible);
    expect(result.violations.map(item => item.type)).toContain('FACT_CONTRADICTION');
  });

  test('9. same fact with an explicit legitimate change event can pass fact checking', () => {
    const { bible, control, state } = fixture();
    const result = validateDeterministicBatchOutput([
      chapter(1, 'The survey token weighed 5 units.'),
      chapter(2, 'After material was added, the survey token changed and weighed 10 units.')
    ], batch([plan(1), plan(2)]), control, state, bible);
    expect(result.violations.map(item => item.type)).not.toContain('FACT_CONTRADICTION');
  });

  test('10. completed discovery is carried into the next Writer context', async () => {
    const run = await runPipeline({ clues: { 1: ['marker X identifies category Y'] } });
    expect(run.prompts.writer[1]).toContain('completedDiscoveries');
    expect(run.prompts.writer[1]).toContain('marker X identifies category Y');
  });

  test('11. repeated first-discovery presentation is classified REPEATED_DISCOVERY', () => {
    expect(parseSemanticValidationResponse(semantic(false, 'REPEATED_DISCOVERY')).violations[0].type)
      .toBe('REPEATED_DISCOVERY');
  });

  test('12. acknowledged plan-approved re-verification can pass', async () => {
    const result = await runSemanticValidation('Prior discovery acknowledged; approved plan requires re-verification.', async () => semantic(true));
    expect(result.status).toBe('PASS');
  });

  test('13. true temporal inconsistency stays CHRONOLOGY_CONTRADICTION', () => {
    expect(parseSemanticValidationResponse(semantic(false, 'CHRONOLOGY_CONTRADICTION')).violations[0].type)
      .toBe('CHRONOLOGY_CONTRADICTION');
  });

  test('14. fact contradiction guidance is distinct from chronology', () => {
    const promptText = buildSemanticValidatorSystemPrompt();
    expect(promptText).toContain('FACT_CONTRADICTION:');
    expect(promptText).toContain('not a chronology issue');
  });

  test('15. repeated discovery guidance is distinct from chronology', () => {
    const promptText = buildSemanticValidatorSystemPrompt();
    expect(promptText).toContain('REPEATED_DISCOVERY:');
    expect(promptText).toContain('presented again as a first discovery');
  });
});

describe('Writer continuity hardening - structural length contract', () => {
  test('16. minimumWords=2000 and output=1285 triggers bounded structural retries', async () => {
    let calls = 0;
    const content = Array.from({ length: 1285 }, () => 'word').join(' ');
    await expect(generateChaptersProse('context', batch([plan(1)]), async () => {
      calls++;
      return xml(1, content);
    }, { minimumWords: 2000 })).rejects.toBeInstanceOf(WriterOutputValidationError);
    expect(calls).toBe(MAX_WRITER_ATTEMPTS);
  });

  test('17. satisfied minimum needs no length repair or retry', async () => {
    let calls = 0;
    const result = await generateChaptersProse('context', batch([plan(1)]), async () => {
      calls++;
      return xml(1, 'one two three four five');
    }, { minimumWords: 5 });
    expect(result.chapters).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test('18. length repair instruction forbids a new major plot event', () => {
    const { control } = fixture();
    const request = buildSafeRepairRequest([{ type: 'WORD_COUNT_DEFICIT', severity: 'HIGH', message: 'short' }], control);
    expect(request[0].instruction).toContain('Do not add filler');
    expect(request[0].instruction).toContain('new major plot event');
  });

  test('19. length repair explicitly expands the existing approved plan', () => {
    const { control } = fixture();
    expect(buildSafeRepairRequest([{ type: 'WORD_COUNT_DEFICIT', severity: 'HIGH', message: 'short' }], control)[0].instruction)
      .toContain('Expand the existing approved plan');
  });

  test('20. Writer structural retries remain capped at three', () => expect(MAX_WRITER_ATTEMPTS).toBe(3));
});

describe('Writer continuity hardening - atomicity and repair safety', () => {
  test('21. failed batch still saves zero chapters', async () => {
    const run = await runPipeline({ count: 1, semanticResponses: [semantic(false, 'PLAN_VIOLATION', 1)], repairResponses: ['bad', 'bad'] });
    expect(run.result).toMatchObject({ success: false, acceptedChapters: [], newMemories: [] });
  });

  test('22. ephemeral continuity lock is not persisted when the batch fails', async () => {
    const run = await runPipeline({
      prose: { 1: 'The survey token weighed 5 units.' }, count: 1,
      semanticResponses: [semantic(false, 'PLAN_VIOLATION', 1)], repairResponses: ['bad', 'bad']
    });
    expect(JSON.stringify(run.result.nextState)).not.toContain('inBatchContinuityLock');
    expect(run.result.nextState).toEqual(run.state);
  });

  test('23. successful batch still commits state atomically after QA', async () => {
    const run = await runPipeline({ count: 2 });
    expect(run.result.success).toBe(true);
    expect(run.result.acceptedChapters.map(item => item.chapterNumber)).toEqual([1, 2]);
    expect(run.result.nextState.currentChapter).toBe(2);
  });

  test('24. FACT_CONTRADICTION repair receives the prior established fact safely', () => {
    const { bible, control, state } = fixture();
    const firstPlan = plan(1);
    const lock = extendInBatchContinuityLock(createEmptyInBatchContinuityLock(), chapter(1, 'The survey token weighed 5 units.'), firstPlan);
    const context = buildWriterContext(bible, control, batch([plan(2)]), state, [], 2, 1, [chapter(1, 'prior')], lock);
    const promptText = buildRepairPrompt([chapter(2, 'The survey token weighed 10 units.')], [{
      type: 'FACT_CONTRADICTION', severity: 'HIGH', chapterNumber: 2, message: 'conflict'
    }], context, control);
    expect(promptText).toContain('"value": "5"');
    expect(promptText).toContain('Preserve the established fact');
  });

  test('25. REPEATED_DISCOVERY repair tells Writer to acknowledge prior knowledge', () => {
    const { control } = fixture();
    expect(buildSafeRepairRequest([{ type: 'REPEATED_DISCOVERY', severity: 'HIGH', message: 'repeat' }], control)[0].instruction)
      .toContain('Acknowledge prior knowledge');
  });

  test('26. repair prompt contains no hidden actualTruth token', () => {
    const { control } = fixture();
    control.mysteryThreads = [{ id: 'm', question: '?', actualTruth: 'ACTUAL_TRUTH_TOKEN', stages: [] }];
    const promptText = buildRepairPrompt([chapter(1, 'ACTUAL_TRUTH_TOKEN')], [{
      type: 'FACT_CONTRADICTION', severity: 'HIGH', chapterNumber: 1, message: 'ACTUAL_TRUTH_TOKEN'
    }], 'safe context', control);
    expect(promptText).not.toContain('ACTUAL_TRUTH_TOKEN');
  });

  test('27. repair prompt contains no author secret', () => {
    const { control } = fixture();
    const promptText = buildRepairPrompt([chapter(1, 'AUTHOR_SECRET_CONTINUITY_X')], [{
      type: 'REPEATED_DISCOVERY', severity: 'HIGH', chapterNumber: 1, message: 'AUTHOR_SECRET_CONTINUITY_X'
    }], 'safe context', control);
    expect(promptText).not.toContain('AUTHOR_SECRET_CONTINUITY_X');
  });
});

describe('Writer continuity hardening - QUALITY routing and diagnostics', () => {
  test('28. semantic story validator enforces the no-Lite quality floor while allowing shared competent candidates', () => {
    const candidates = getStoryModelCandidates('STORY_VALIDATOR_SEMANTIC');
    expect(candidates.some(candidate => candidate.includes('lite'))).toBe(false);
    const sharedPolicy: StoryModelPolicy = {
      FAST: ['gemini-3.7-flash'], QUALITY: ['gemini-3.7-flash']
    };
    expect(getStoryModelCandidates('STORY_VALIDATOR_SEMANTIC', false, sharedPolicy)).toEqual(['gemini-3.7-flash']);
  });

  test('29. semantic plan validator never routes to Lite', () => {
    const candidates = getStoryModelCandidates('PLAN_VALIDATOR_SEMANTIC');
    expect(candidates.some(candidate => candidate.includes('lite'))).toBe(false);
  });

  test('30. Writer and AutoRepair follow the same central QUALITY policy', () => {
    const writer = getStoryModelCandidates('WRITER');
    const repair = getStoryModelCandidates('AUTO_REPAIR');
    expect(writer).toEqual(repair);
    expect(writer.every(candidate => isStoryModelAllowedForRole('WRITER', candidate))).toBe(true);
  });

  test('31. 429 on the first configured QUALITY candidate falls back to the second QUALITY candidate', async () => {
    const policy: StoryModelPolicy = { FAST: ['gemini-3.5-flash-lite'], QUALITY: ['gemini-3.1-pro-preview', 'gemini-3.7-flash'] };
    const calls: string[] = [];
    const result = await runApprovedStoryModelCandidates('STORY_VALIDATOR_SEMANTIC', async model => {
      calls.push(model);
      if (model === 'gemini-3.1-pro-preview') throw new Error('429 rate limited');
      return 'ok';
    }, policy);
    expect(result).toBe('ok');
    expect(calls).toEqual(['gemini-3.1-pro-preview', 'gemini-3.7-flash']);
  });

  test('32. all semantic QUALITY candidates unavailable returns QA_UNAVAILABLE and saves nothing', async () => {
    let calls = 0;
    const run = await runPipeline({ count: 1, semanticRunner: async () => {
      calls++;
      throw new Error('429 all approved QUALITY candidates exhausted');
    } });
    expect(run.result.validationResult.status).toBe('QA_UNAVAILABLE');
    expect(run.result.acceptedChapters).toEqual([]);
    expect(calls).toBe(2);
  });

  test('33. candidate exhaustion has no infinite rate-limit retry', async () => {
    const policy: StoryModelPolicy = { FAST: ['gemini-3.5-flash-lite'], QUALITY: ['gemini-3.1-pro-preview', 'gemini-3.7-flash'] };
    let calls = 0;
    await expect(runApprovedStoryModelCandidates('WRITER', async () => {
      calls++;
      throw new Error('429');
    }, policy)).rejects.toThrow('429');
    expect(calls).toBe(2);
  });

  test('34. diagnostics preserve new violation types, messages, and evidence', () => {
    const { control } = fixture();
    const violation: StoryViolation = {
      type: 'FACT_CONTRADICTION', severity: 'HIGH', chapterNumber: 2,
      message: 'Quantity changed.', evidence: '10 units'
    };
    const result = canonicalizeStoryValidation(false, [violation]);
    const text = formatSemanticQaDiagnosticLines(result, control).join('\n');
    expect(text).toContain('type=FACT_CONTRADICTION');
    expect(text).toContain('message=Quantity changed.');
    expect(text).toContain('evidence=10 units');
  });

  test('35. existing six semantic failure classes remain supported', () => {
    const promptText = buildSemanticValidatorSystemPrompt();
    for (const type of ['LOCATION_CANON_CONTRADICTION', 'CHARACTER_SKILL_DRIFT', 'COMBAT_POWER_VIOLATION', 'OPPONENT_COMPETENCE_FAILURE', 'PREMATURE_MYSTERY_RESOLUTION', 'REAL_WORLD_CONTAMINATION']) {
      expect(promptText).toContain(type);
    }
  });

  test('36. nearby-valid allowlisted and explicit-change cases remain unblocked', () => {
    const { bible, control, state } = fixture(true);
    const result = validateDeterministicBatchOutput([
      chapter(1, 'The survey token weighed 5 units. Лан Canon recorded it.'),
      chapter(2, 'Material was added; the survey token changed and weighed 10 units. API remained an allowed term.')
    ], batch([plan(1), plan(2)]), control, state, bible);
    expect(result.violations.map(item => item.type)).not.toEqual(expect.arrayContaining(['FACT_CONTRADICTION', 'REAL_WORLD_CONTAMINATION']));
    expect(() => validateWriterOutput(xml(2, 'API is allowlisted'), [2], {
      minimumWords: 1, outputLanguage: createOutputLanguageContract(control, bible)
    })).not.toThrow();
  });
});
