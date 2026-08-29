import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createStoryControlFromBlueprint, validateBlueprintV3Object } from '../src/services/storyEngine/blueprintParser';
import { computeBibleHash } from '../src/services/storyEngine/compiler';
import { runStoryEnginePipeline } from '../src/services/storyEngine/pipeline';
import { applySetupImport, parseSetupFileContent } from '../src/services/storyEngine/setupImport';
import { runStoryEngineSanityCheck } from '../src/services/storyEngine/sanity';
import { compactMemoryIndex, retrieveRelevantMemories } from '../src/services/storyEngine/memoryManager';
import {
  canonicalizeStoryValidation,
  parseSemanticValidationResponse,
  runSemanticValidation
} from '../src/services/storyEngine/semanticValidator';
import {
  formatSemanticQaDiagnosticLines,
  sanitizeValidationResultForDiagnostics
} from '../src/services/storyEngine/diagnostics';
import { buildLogFileContent } from '../src/utils/logExport';
import {
  ChapterMemory,
  ChapterPlan,
  MEMORY_SCHEMA_VERSION,
  STORY_STATE_SCHEMA_VERSION,
  StoryBible,
  StoryControl,
  StoryState,
  StoryViolationType
} from '../src/services/storyEngine/types';
import { CreativeChapter, CreativeState } from '../src/types';

const CANARIES = [
  'AUTHOR_SECRET_FINAL_X91',
  'MYSTERY_TRUTH_FINAL_Q72',
  'LOCKED_FACT_FINAL_P63',
  'FUTURE_CHARACTER_FINAL_K84',
  'FUTURE_ARC_FINAL_Z55'
] as const;

const DIAGNOSTIC_CANARIES = [
  'AUTHOR_SECRET_DIAG_X91',
  'MYSTERY_TRUTH_DIAG_Q72',
  'LOCKED_FACT_DIAG_P63',
  'FUTURE_PROFILE_DIAG_K84',
  'FUTURE_ARC_DIAG_Z55'
] as const;

function rawBlueprint(arcs = [
  { id: 'arc_a', title: 'Arc A', startChapter: 1, endChapter: 18, theme: 'Present investigation', coreConflict: 'Find a local witness' },
  { id: 'arc_b', title: 'Arc B', startChapter: 19, endChapter: 20, theme: CANARIES[4], coreConflict: 'Future conflict' }
]) {
  return {
    schemaVersion: 3,
    totalChapters: arcs[arcs.length - 1].endChapter,
    settings: {
      readerSafePremise: 'A careful investigation in a fictional river district.',
      semanticQaTimeoutMs: 20,
      bannedPhrases: ['fate moves pieces on a chessboard']
    },
    characterRegistry: [
      {
        id: 'hero', name: 'Lan', role: 'social investigator', appearance: 'plain travel coat', personality: 'observant',
        restrictions: ['human-limited', 'not an elite swordsman'], unlockChapter: 1, directAppearanceChapter: 1,
        povUnlockChapter: 1, majorFocusNotBeforeChapter: 1
      },
      {
        id: 'future', name: 'The Envoy', role: 'future witness', appearance: CANARIES[3], personality: 'guarded',
        restrictions: ['future arc only'], unlockChapter: 19, directAppearanceChapter: 19,
        povUnlockChapter: 19, majorFocusNotBeforeChapter: 19
      }
    ],
    worldFacts: [
      { id: 'district', fact: 'Vinh district is an inland county.', visibility: 'always', introducedAtChapter: 1 },
      { id: 'river', fact: 'The Nhu river is a waterway beside Vinh district.', visibility: 'always', introducedAtChapter: 1 },
      { id: 'locked', fact: CANARIES[2], visibility: 'gated', unlockChapter: 15 }
    ],
    arcs: arcs.map(arc => ({ ...arc, climaxChapter: arc.endChapter, pacing: 'accelerating', keyMilestones: [], forbiddenSpoilers: [] })),
    narrativeExposureRules: [{
      id: 'early', startChapter: 1, endChapter: 10,
      allowedEvidence: ['odd evidence'], forbiddenEvidence: ['complete transport ledger'],
      allowedInferences: ['local organization suspicion'], forbiddenInferences: ['complete conspiracy pipeline'],
      readerKnowledgeCeiling: 'Suspicion only', relatedWorldFactIds: ['district', 'river']
    }],
    mysteryThreads: [{
      id: 'river_mystery', question: 'Who moved the cargo?', actualTruth: CANARIES[1],
      stages: [{
        id: 'early_stage', startChapter: 1, endChapter: 10,
        allowedKnowledge: ['odd evidence'], allowedEvidence: ['odd evidence'],
        allowedInferences: ['local organization suspicion'], readerKnowledgeCeiling: 'Suspicion only'
      }]
    }],
    authorOnlySecrets: [CANARIES[0]],
    originality: { bannedPhrases: ['fate moves pieces on a chessboard'] }
  };
}

function fixture() {
  const blueprint = validateBlueprintV3Object(rawBlueprint());
  const bible: StoryBible = {
    seedTitle: 'Task 5 acceptance', genre: 'Historical detective',
    seriesPremise: 'A reader-safe investigation.', continuitySummary: 'A prior witness left an unpaid debt.',
    worldNotes: 'Strict fictional historical setting.', charNotes: 'Lan relies on etiquette and contacts.',
    outline: 'Investigate without resolving the mystery early.',
    characters: [{
      id: 'hero', name: 'Lan', gender: '', age: '', role: 'social investigator',
      appearance: 'plain travel coat', personality: 'observant'
    }],
    totalPlannedChapters: 20,
    blueprintV3: blueprint,
    storyEngineSettingsV3: { readerSafePremise: 'A careful investigation in a fictional river district.' }
  };
  const control = createStoryControlFromBlueprint(blueprint, computeBibleHash(bible), bible.storyEngineSettingsV3);
  control.pacingRules.minWordsPerChapter = 1;
  control.settings = { ...(control.settings || {}), semanticQaTimeoutMs: 2 };
  return { bible, control };
}

function state(control: StoryControl, currentChapter: number): StoryState {
  return {
    schemaVersion: STORY_STATE_SCHEMA_VERSION,
    sourceHash: control.sourceHash,
    currentChapter,
    characterStates: {
      hero: {
        characterId: 'hero', name: 'Lan', location: 'Vinh district', priorLocation: 'Old ferry',
        physicalCondition: 'A severe leg injury remains active.', knownFacts: ['odd evidence'], goals: ['find witness'],
        injuries: [{
          id: 'leg_wound', type: 'leg wound', bodyPart: 'leg', severity: 'severe', receivedChapter: 3,
          expectedRecoveryChapter: 6, restrictions: ['cannot sprint'], status: 'active'
        }]
      }
    },
    relationships: [{
      characterA: 'Lan', characterB: 'Witness', trust: 60, hostility: 0, stage: 'uneasy allies',
      debt: 'Lan owes safe passage', lastMajorChangeChapter: 4
    }],
    resources: { money: 'low', equipment: ['walking staff'] },
    clues: [], unresolvedThreads: ['river_mystery'],
    longTermSeeds: [{ id: 'old_seed', plantedChapter: 1, meaningHidden: 'unpaid bell debt', eligibleCallbackFromChapter: 7, status: 'planted' }],
    recentConsequences: ['leg injury'], currentArcId: currentChapter >= 19 ? 'arc_b' : 'arc_a', currentArcProgress: 0,
    unlockedCharacterIds: ['hero'], worldFactStates: { district: 'revealed', river: 'revealed', locked: 'hidden' },
    knowledgeLedger: [{ factId: 'odd', fact: 'The seal is reversed.', learnedChapter: 5, source: 'witnessed', confidence: 1 }],
    timeline: [{ chapter: 6, marker: 'late afternoon', relativeChronology: 'same_day', location: 'Vinh district' }],
    continuitySummary: 'The mentor died irreversibly; the river mystery and leg injury remain active.'
  };
}

function existingChapters(count: number): CreativeChapter[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `old_${index + 1}`, chapterNumber: index + 1, title: `Chapter ${index + 1}`,
    content: `OLD_CHAPTER_${index + 1}`, status: 'completed'
  }));
}

function plan(chapterNumber: number): ChapterPlan {
  return {
    chapterNumber, arcId: chapterNumber <= 18 ? 'arc_a' : 'arc_b', title: `Chapter ${chapterNumber}`,
    focus: 'Follow the approved local clue.', primaryGoal: 'Follow the approved local clue.', povCharacter: 'Lan',
    pacingTarget: 'rising_action', requiredEvents: [], introducedCharacters: [], activeCharacters: ['Lan'],
    worldFactInteractions: ['district', 'river'], cluesDiscovered: [], forbiddenSpoilers: [], plannedCharacters: ['Lan'],
    plannedWorldFacts: ['district', 'river'], plannedEvidence: ['odd evidence'],
    plannedInferences: ['local organization suspicion'], continuityRequirements: ['respect active leg injury'], arcBeatIds: []
  };
}

function xml(chapterNumber: number, content = `SAFE_PROSE_CHAPTER_${chapterNumber}`): string {
  return `<CHAPTER number="${chapterNumber}" title="Chapter ${chapterNumber}: Accepted">${content}</CHAPTER>`;
}

function semantic(pass: boolean, type?: StoryViolationType, evidence = 'unsafe passage'): string {
  return JSON.stringify({
    pass,
    violations: type ? [{
      type, severity: 'HIGH', chapterNumber: 7, message: `Detected ${type}.`, evidence,
      suggestedRepair: 'Rewrite safely using only approved context.'
    }] : []
  });
}

interface HarnessOptions {
  startChapter?: number;
  count?: number;
  prose?: Record<number, string>;
  semanticResponses?: string[];
  planSemanticResponses?: string[];
  repairResponses?: string[];
  malformedWriter?: boolean;
  noQualityRunner?: boolean;
  noSemanticRunner?: boolean;
  semanticRunner?: (prompt: string, systemInstruction: string) => Promise<string>;
  stateResponse?: string;
  criticalStateFailure?: boolean;
}

async function execute(options: HarnessOptions = {}) {
  const { bible, control } = fixture();
  const startChapter = options.startChapter || 7;
  const count = options.count || 2;
  const chapters = existingChapters(startChapter - 1);
  const currentState = state(control, startChapter - 1);
  let stateIntegrationStarted = false;
  if (options.criticalStateFailure) {
    currentState.characterStates = new Proxy(currentState.characterStates, {
      ownKeys(target) {
        if (stateIntegrationStarted) throw new Error('simulated critical state merge failure');
        return Reflect.ownKeys(target);
      }
    });
  }
  const prompts = { planner: [] as string[], planValidator: [] as string[], writer: [] as string[], validator: [] as string[], validatorSystem: [] as string[], repair: [] as string[], state: [] as string[] };
  const systems = { planner: [] as string[], planValidator: [] as string[] };
  const logs: string[] = [];
  let semanticIndex = 0;
  let planSemanticIndex = 0;
  let repairIndex = 0;
  let writerCalls = 0;
  const fast = async (prompt: string, systemInstruction = '') => {
    if (systemInstruction.includes('Chapter Planner')) {
      prompts.planner.push(prompt); systems.planner.push(systemInstruction);
      const number = Number(systemInstruction.match(/\[(\d+)\]/)?.[1] || startChapter);
      return JSON.stringify({ chapters: [plan(number)] });
    }
    if (systemInstruction.includes('State Extractor')) {
      prompts.state.push(prompt);
      stateIntegrationStarted = true;
      return options.stateResponse || JSON.stringify({
        batchSummary: `Accepted chapters ${startChapter}-${startChapter + count - 1}`,
        unresolvedThreads: ['river_mystery'],
        chapterSummaries: Array.from({ length: count }, (_, index) => ({
          chapterNumber: startChapter + index, summary: `Memory ${startChapter + index}`,
          charactersInvolved: ['Lan'], locations: [startChapter + index === 19 ? 'Arc B gate' : 'Vinh district']
        }))
      });
    }
    writerCalls++;
    const number = Number(systemInstruction.match(/\[(\d+)\]/)?.[1] || startChapter);
    return options.malformedWriter ? 'malformed writer output' : xml(number, options.prose?.[number]);
  };
  const quality = async (prompt: string, systemInstruction = '') => {
    if (systemInstruction.includes('semantic plan validator')) {
      prompts.planValidator.push(prompt); systems.planValidator.push(systemInstruction);
      return options.planSemanticResponses?.[planSemanticIndex++] || JSON.stringify({ pass: true, violations: [] });
    }
    if (systemInstruction.includes('repair writer')) {
      prompts.repair.push(prompt);
      const number = Number(systemInstruction.match(/\[(\d+)\]/)?.[1] || startChapter);
      return options.repairResponses?.[repairIndex++] || xml(number, `REPAIRED_${number}`);
    }
    writerCalls++;
    prompts.writer.push(prompt);
    const number = Number(systemInstruction.match(/\[(\d+)\]/)?.[1] || startChapter);
    return options.malformedWriter ? 'malformed writer output' : xml(number, options.prose?.[number]);
  };
  const semanticRunner = options.semanticRunner || (async (prompt: string, systemInstruction: string) => {
    prompts.validator.push(prompt);
    prompts.validatorSystem.push(systemInstruction);
    return options.semanticResponses?.[semanticIndex++] || semantic(true);
  });
  const inputSnapshot = JSON.stringify({ chapters, state: currentState });
  const result = await runStoryEnginePipeline({
    bible,
    existingControl: control,
    existingState: currentState,
    existingMemories: [{
      id: 'memory_old_seed', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash,
      chapterNumber: 1, title: 'Old seed', summary: 'The unpaid bell debt remains unresolved.', charactersInvolved: ['Lan'],
      locations: ['Old ferry'], seedIds: ['old_seed'], injuryIds: ['leg_wound'], relationshipIds: ['lan###witness'], importance: 95
    }],
    existingChapters: chapters,
    batchSize: count,
    aiFastRunner: fast,
    aiProRunner: options.noQualityRunner ? undefined : quality,
    aiSemanticRunner: options.noSemanticRunner ? undefined : semanticRunner,
    onLog: message => logs.push(message)
  });
  stateIntegrationStarted = false;
  return { result, bible, control, currentState, chapters, prompts, systems, logs, writerCalls, inputSnapshot };
}

function diagnosticControl(): StoryControl {
  const { control } = fixture();
  control.authorOnlySecrets = [DIAGNOSTIC_CANARIES[0]];
  const mysteryThread = control.mysteryThreads[0];
  if (mysteryThread && typeof mysteryThread === 'object' && !Array.isArray(mysteryThread)) {
    mysteryThread.actualTruth = DIAGNOSTIC_CANARIES[1];
  }
  const lockedFact = control.worldFacts.find(fact => fact.id === 'locked');
  if (lockedFact) lockedFact.fact = DIAGNOSTIC_CANARIES[2];
  const futureCharacter = Object.values(control.characterRegistry).find(character => character.id === 'future');
  if (futureCharacter) futureCharacter.appearance = DIAGNOSTIC_CANARIES[3];
  const futureArc = control.arcs.find(arc => arc.id === 'arc_b');
  if (futureArc) futureArc.theme = DIAGNOSTIC_CANARIES[4];
  return control;
}

function diagnosticFailure(text: string, type: StoryViolationType = 'PLAN_VIOLATION') {
  return canonicalizeStoryValidation(false, [{
    type,
    severity: 'HIGH',
    chapterNumber: 7,
    message: `Message ${text}`,
    evidence: `Evidence ${text}`,
    suggestedRepair: `Repair without ${text}`
  }], [], { attempts: 1 });
}

describe('Story Engine QA diagnostics patch', () => {
  test('1. FAIL violation message is preserved', () => {
    const parsed = parseSemanticValidationResponse(JSON.stringify({
      pass: false,
      violations: [{ type: 'PLAN_VIOLATION', severity: 'HIGH', message: 'Primary goal was omitted.' }]
    }));
    expect(parsed.pass).toBe(false);
    expect(parsed.violations[0].message).toBe('Primary goal was omitted.');
  });

  test('2. evidence is preserved', () => {
    const parsed = parseSemanticValidationResponse(JSON.stringify({
      pass: false,
      violations: [{ type: 'PLAN_VIOLATION', severity: 'HIGH', message: 'Goal omitted.', evidence: 'The caravan turns away.' }]
    }));
    expect(parsed.violations[0].evidence).toBe('The caravan turns away.');
  });

  test('3. suggestedRepair is preserved', () => {
    const parsed = parseSemanticValidationResponse(JSON.stringify({
      pass: false,
      violations: [{
        type: 'PLAN_VIOLATION', severity: 'HIGH', message: 'Goal omitted.',
        suggestedRepair: 'Restore the approved meeting without adding a reveal.'
      }]
    }));
    expect(parsed.violations[0].suggestedRepair).toBe('Restore the approved meeting without adding a reveal.');
  });

  test('4. chapter number and related identifiers are preserved', () => {
    const parsed = parseSemanticValidationResponse(JSON.stringify({
      pass: false,
      violations: [{
        type: 'KNOWLEDGE_LEAK', severity: 'HIGH', chapterNumber: 2, message: 'Unsupported fact.',
        relatedRuleId: 'rule_2', relatedCharacter: 'Lan', relatedThreadId: 'thread_2'
      }]
    }));
    expect(parsed.violations[0]).toMatchObject({
      chapterNumber: 2, relatedRuleId: 'rule_2', relatedCharacter: 'Lan', relatedThreadId: 'thread_2'
    });
  });

  test('5. multiple violations are logged individually after the unchanged summary', async () => {
    const response = JSON.stringify({
      pass: false,
      violations: [
        { type: 'PLAN_VIOLATION', severity: 'HIGH', chapterNumber: 7, message: 'Plan issue.', evidence: 'First excerpt.' },
        { type: 'CHRONOLOGY_CONTRADICTION', severity: 'HIGH', chapterNumber: 7, message: 'Time issue.', evidence: 'Second excerpt.' }
      ]
    });
    const run = await execute({ count: 1, semanticResponses: [response], repairResponses: ['malformed', 'malformed'] });
    const details = run.logs.filter(line => line.startsWith('[Semantic QA Detail]'));
    expect(details).toHaveLength(2);
    expect(run.logs.join('\n')).toContain('violations=PLAN_VIOLATION:HIGH,CHRONOLOGY_CONTRADICTION:HIGH');
  });

  test('6. Repair Attempt 1 revalidation logs its new violation detail', async () => {
    const run = await execute({
      count: 1,
      semanticResponses: [
        semantic(false, 'PLAN_VIOLATION', 'initial plan excerpt'),
        semantic(false, 'CHRONOLOGY_CONTRADICTION', 'repair one chronology excerpt'),
        semantic(true)
      ],
      repairResponses: [xml(7, 'REPAIR_ONE'), xml(7, 'REPAIR_TWO')]
    });
    const logs = run.logs.join('\n');
    expect(logs).toContain('repairAttempt=1 status=FAIL violations=CHRONOLOGY_CONTRADICTION:HIGH');
    expect(logs).toContain('evidence=repair one chronology excerpt');
  });

  test('7. Repair Attempt 2 revalidation logs its final violation detail', async () => {
    const run = await execute({
      count: 1,
      semanticResponses: [
        semantic(false, 'PLAN_VIOLATION', 'initial plan excerpt'),
        semantic(false, 'CHRONOLOGY_CONTRADICTION', 'repair one chronology excerpt'),
        semantic(false, 'REAL_WORLD_CONTAMINATION', 'repair two contamination excerpt')
      ],
      repairResponses: [xml(7, 'REPAIR_ONE'), xml(7, 'REPAIR_TWO')]
    });
    const logs = run.logs.join('\n');
    expect(logs).toContain('repairAttempt=2 status=FAIL violations=REAL_WORLD_CONTAMINATION:HIGH');
    expect(logs).toContain('evidence=repair two contamination excerpt');
  });

  test('8. mystery actualTruth is redacted from diagnostic log text', () => {
    const logs = formatSemanticQaDiagnosticLines(diagnosticFailure(DIAGNOSTIC_CANARIES[1]), diagnosticControl()).join('\n');
    expect(logs).not.toContain(DIAGNOSTIC_CANARIES[1]);
    expect(logs).toContain('[HIDDEN_DETAIL]');
  });

  test('9. author-only secret is redacted from diagnostic log text', () => {
    const logs = formatSemanticQaDiagnosticLines(diagnosticFailure(DIAGNOSTIC_CANARIES[0]), diagnosticControl()).join('\n');
    expect(logs).not.toContain(DIAGNOSTIC_CANARIES[0]);
  });

  test('10. locked world fact is redacted from diagnostic log text', () => {
    const logs = formatSemanticQaDiagnosticLines(diagnosticFailure(DIAGNOSTIC_CANARIES[2]), diagnosticControl()).join('\n');
    expect(logs).not.toContain(DIAGNOSTIC_CANARIES[2]);
  });

  test('11. future character profile is redacted from diagnostic log text', () => {
    const result = diagnosticFailure(DIAGNOSTIC_CANARIES[3]);
    result.violations[0].chapterNumber = undefined;
    result.violations[0].chapter = undefined;
    const logs = formatSemanticQaDiagnosticLines(result, diagnosticControl()).join('\n');
    expect(logs).not.toContain(DIAGNOSTIC_CANARIES[3]);
  });

  test('12. future arc spoiler is redacted from diagnostic log text', () => {
    const logs = formatSemanticQaDiagnosticLines(diagnosticFailure(DIAGNOSTIC_CANARIES[4]), diagnosticControl()).join('\n');
    expect(logs).not.toContain(DIAGNOSTIC_CANARIES[4]);
  });

  test('13. diagnostic fields do not change PASS or FAIL verdict semantics', async () => {
    const pass = await runSemanticValidation('view', async () => JSON.stringify({
      pass: true, violations: [], warnings: [{ type: 'CLICHE_OVERUSE', severity: 'LOW', message: 'Advisory.', evidence: 'Brief.' }]
    }));
    const fail = await runSemanticValidation('view', async () => JSON.stringify({
      pass: false, violations: [{ type: 'PLAN_VIOLATION', severity: 'HIGH', message: 'Blocking.', evidence: 'Brief.' }]
    }));
    expect(pass.status).toBe('PASS');
    expect(fail.status).toBe('FAIL');
  });

  test('14. fail-closed retry bound and QA_UNAVAILABLE behavior are unchanged', async () => {
    let calls = 0;
    const result = await runSemanticValidation('view', async () => { calls++; return '{invalid'; });
    expect(calls).toBe(2);
    expect(result).toMatchObject({ pass: false, status: 'QA_UNAVAILABLE', attempts: 2 });
  });

  test('15. exported error log contains safe details for initial QA and both repairs', async () => {
    const run = await execute({
      count: 1,
      semanticResponses: [
        semantic(false, 'PLAN_VIOLATION', 'initial evidence'),
        semantic(false, 'CHRONOLOGY_CONTRADICTION', 'repair one evidence'),
        semantic(false, 'REAL_WORLD_CONTAMINATION', 'repair two evidence')
      ],
      repairResponses: [xml(7, 'REPAIR_ONE'), xml(7, 'REPAIR_TWO')]
    });
    const entries = run.logs.map((message, index) => ({
      id: `diag_${index}`, timestamp: new Date(index * 1000), message, type: 'info' as const
    }));
    const canaryEntries = formatSemanticQaDiagnosticLines(
      diagnosticFailure(DIAGNOSTIC_CANARIES.join(' / ')), diagnosticControl()
    ).map((message, index) => ({
      id: `canary_${index}`, timestamp: new Date(index * 1000), message, type: 'info' as const
    }));
    const exported = buildLogFileContent([...entries, ...canaryEntries]);
    expect(exported).toContain('type=PLAN_VIOLATION');
    expect(exported).toContain('type=CHRONOLOGY_CONTRADICTION');
    expect(exported).toContain('type=REAL_WORLD_CONTAMINATION');
    expect(exported).toContain('evidence=repair two evidence');
    for (const token of DIAGNOSTIC_CANARIES) expect(exported).not.toContain(token);
  });

  test('16. malformed optional diagnostic fields do not crash or weaken a blocking verdict', async () => {
    const result = await runSemanticValidation('view', async () => JSON.stringify({
      pass: false,
      violations: [{
        type: 'PLAN_VIOLATION', severity: 'HIGH', message: 'Still blocking.', chapterNumber: 'bad',
        evidence: { malformed: true }, suggestedRepair: 42, relatedRuleId: [], relatedCharacter: false
      }]
    }));
    expect(result).toMatchObject({ pass: false, status: 'FAIL', attempts: 1 });
    expect(result.violations[0]).toMatchObject({ message: 'Still blocking.', evidence: undefined, chapterNumber: undefined });
  });

  test('17. persisted validation diagnostics retain related identifiers', () => {
    const { bible, control } = fixture();
    const parsed = parseSetupFileContent(JSON.stringify({
      importType: 'FULL_PROJECT', seedTitle: bible.seedTitle, storyControl: control,
      storyState: state(control, 7), memoryIndex: [], chapters: [],
      lastValidationResult: {
        ...diagnosticFailure('safe detail'),
        violations: [{
          type: 'KNOWLEDGE_LEAK', severity: 'HIGH', chapterNumber: 7, message: 'Unsupported fact.',
          evidence: 'Short excerpt.', suggestedRepair: 'Remove certainty.',
          relatedRuleId: 'rule_7', relatedCharacter: 'Lan', relatedThreadId: 'river_mystery'
        }]
      }
    }));
    expect(parsed?.lastValidationResult?.violations[0]).toMatchObject({
      relatedRuleId: 'rule_7', relatedCharacter: 'Lan', relatedThreadId: 'river_mystery'
    });
  });

  test('18. user-facing diagnostic state contains no raw security canary', () => {
    const combined = DIAGNOSTIC_CANARIES.join(' / ');
    const safeState = sanitizeValidationResultForDiagnostics(diagnosticFailure(combined), diagnosticControl());
    const serialized = JSON.stringify(safeState);
    for (const token of DIAGNOSTIC_CANARIES) expect(serialized).not.toContain(token);
  });

  test('19. API credentials are redacted from persisted diagnostic text', () => {
    const apiKey = 'AIza1234567890abcdefghijklmnop';
    const logs = formatSemanticQaDiagnosticLines(diagnosticFailure(apiKey), diagnosticControl()).join('\n');
    expect(logs).not.toContain(apiKey);
    expect(logs).toContain('[REDACTED_API_KEY]');
  });
});

describe('Story Engine Task 5 - production pipeline acceptance', () => {
  test('happy path Ch7-8 runs the production orchestration and commits exactly two coherent chapters', async () => {
    const run = await execute();
    expect(run.result.success).toBe(true);
    expect(run.result.acceptedChapters.map(chapter => chapter.chapterNumber)).toEqual([7, 8]);
    expect(run.result.batchPlan.chapters.map(chapter => chapter.arcId)).toEqual(['arc_a', 'arc_a']);
    expect(run.result.nextState.currentChapter).toBe(8);
    expect(run.result.nextMemories.filter(memory => memory.chapterNumber >= 7)).toHaveLength(2);
    expect(run.result.nextState.unresolvedThreads).toContain('river_mystery');
    expect(run.result.nextState.characterStates.lan.injuries[0].status).toBe('active');
    expect(run.prompts.writer[1]).toContain('SAFE_PROSE_CHAPTER_7');
    expect(run.logs.join('\n')).toContain('role=PLAN_VALIDATOR_SEMANTIC tier=QUALITY');
    expect(run.logs.join('\n')).toContain('role=STATE_EXTRACTOR tier=FAST');
  });

  test('cross-arc Ch18-19 isolates future Arc B from Ch18 and carries accepted Ch18 prose into Ch19', async () => {
    const run = await execute({ startChapter: 18, count: 2 });
    expect(run.result.success).toBe(true);
    expect(run.result.batchPlan.chapters.map(chapter => chapter.arcId)).toEqual(['arc_a', 'arc_b']);
    expect(run.prompts.writer[0]).not.toContain(CANARIES[4]);
    expect(run.prompts.writer[1]).toContain(CANARIES[4]);
    expect(run.prompts.writer[1]).toContain('SAFE_PROSE_CHAPTER_18');
    expect(run.result.acceptedChapters).toHaveLength(2);
    expect(run.result.nextState.currentArcId).toBe('arc_b');
  });

  test('full invocation canary: Planner/Writer/Repair/Memory/Sanity hide truth while internal validators receive it', async () => {
    const evidence = CANARIES.join(' / ');
    const run = await execute({
      count: 1,
      semanticResponses: [semantic(false, 'CHARACTER_SKILL_DRIFT', evidence), semantic(true)],
      repairResponses: [xml(7, 'SAFE_REPAIRED_CANARY_PROSE')]
    });
    expect(run.result.success).toBe(true);
    const readerPayload = [run.prompts.planner.join('\n'), run.prompts.writer.join('\n'), run.prompts.repair.join('\n'), run.prompts.state.join('\n')].join('\n');
    for (const token of CANARIES) expect(readerPayload).not.toContain(token);
    for (const token of CANARIES) expect(run.prompts.validator[0]).toContain(token);
    const sanity = runStoryEngineSanityCheck({
      bible: run.bible, control: run.control, state: run.currentState,
      modelAvailability: { FAST: true, QUALITY: true }, strict: true
    });
    for (const token of CANARIES) expect(JSON.stringify(sanity)).not.toContain(token);
  });

  test.each([
    ['LOCATION_CANON_CONTRADICTION', 'The prose calls Vinh both the county and the river.'],
    ['CHRONOLOGY_CONTRADICTION', 'That same night she says the late-afternoon event happened yesterday.'],
    ['CHARACTER_SKILL_DRIFT', 'The etiquette specialist displays elite sword mastery.'],
    ['COMBAT_POWER_VIOLATION', 'The human snaps a steel weapon effortlessly with energy-like force.'],
    ['OPPONENT_COMPETENCE_FAILURE', 'A large armed group attacks one at a time and never adapts while losing at zero cost.'],
    ['PREMATURE_MYSTERY_RESOLUTION', 'One odd seal proves the complete conspiracy pipeline and its mastermind.'],
    ['REAL_WORLD_CONTAMINATION', 'She invokes a real dynasty, clock direction, chemistry, and modern financial liability.'],
    ['CLICHE_OVERUSE', 'Destiny arranges every life as pieces across an unseen game board.']
  ] as const)('%s blocks the real pipeline and saves zero when repair cannot produce structure', async (type, prose) => {
    const run = await execute({
      count: 1, prose: { 7: prose }, semanticResponses: [semantic(false, type, prose)],
      repairResponses: ['malformed', 'still malformed']
    });
    expect(run.result.success).toBe(false);
    expect(run.result.acceptedChapters).toEqual([]);
    expect(run.result.newMemories).toEqual([]);
    expect(run.result.validationResult.violations.some(violation => violation.type === type)).toBe(true);
    expect(run.prompts.validatorSystem.join('\n')).toContain(type);
  });

  test.each([
    'A small group wins through terrain, surprise, adaptation, injury, and a real cost.',
    'The magistrate reads an ordinary historical ledger using generic period vocabulary.',
    'The canonically trained guard performs a human-plausible parry and retreats.',
    'Lan keeps the mystery at local-organization suspicion after finding odd evidence.',
    'The canonical alias Vinh County identifies the same inland district.',
    'After dawn on the next day, Lan accurately calls the prior-night event yesterday.'
  ])('nearby valid case is accepted rather than deterministically over-blocked: %s', async prose => {
    const run = await execute({ count: 1, prose: { 7: prose }, semanticResponses: [semantic(true)] });
    expect(run.result.success).toBe(true);
    expect(run.result.acceptedChapters).toHaveLength(1);
  });

  test('semantic plan rejection repeats three bounded attempts and Writer never runs', async () => {
    const run = await execute({
      count: 1,
      planSemanticResponses: Array.from({ length: 3 }, () => JSON.stringify({ pass: false, violations: ['PREMATURE_REVEAL'] }))
    });
    expect(run.result.success).toBe(false);
    expect(run.prompts.planValidator).toHaveLength(3);
    expect(run.prompts.writer).toHaveLength(0);
    expect(run.writerCalls).toBe(0);
    for (const token of CANARIES) expect(run.systems.planner.join('\n')).not.toContain(token);
  });

  test('Writer malformed for all three structural attempts saves zero', async () => {
    const run = await execute({ count: 1, malformedWriter: true });
    expect(run.result.success).toBe(false);
    expect(run.result.acceptedChapters).toEqual([]);
    expect(run.writerCalls).toBe(3);
  });

  test('semantic timeout, invalid JSON, unavailable runner, and pass=false/empty all fail closed', async () => {
    const timeout = await execute({ count: 1, semanticRunner: async () => new Promise<string>(() => undefined) });
    const invalid = await execute({ count: 1, semanticResponses: ['{bad', '{bad'] });
    const unavailable = await execute({ count: 1, noQualityRunner: true, noSemanticRunner: true });
    const falseEmpty = await execute({ count: 1, semanticResponses: [semantic(false)] });
    for (const run of [timeout, invalid, unavailable, falseEmpty]) {
      expect(run.result.success).toBe(false);
      expect(run.result.acceptedChapters).toEqual([]);
      expect(run.result.newMemories).toEqual([]);
    }
    expect(timeout.result.validationResult.status).toBe('QA_UNAVAILABLE');
    expect(invalid.result.validationResult.status).toBe('QA_UNAVAILABLE');
    expect(unavailable.result.validationResult.status).toBe('QA_UNAVAILABLE');
    expect(falseEmpty.result.validationResult.status).toBe('FAIL');
  });

  test('Repair 1 structural failure then Repair 2 pass saves only the final repaired prose', async () => {
    const run = await execute({
      count: 1,
      semanticResponses: [semantic(false, 'PLAN_VIOLATION'), semantic(true)],
      repairResponses: ['malformed', xml(7, 'ONLY_FINAL_REPAIR')]
    });
    expect(run.result.success).toBe(true);
    expect(run.result.repairCount).toBe(2);
    expect(run.result.acceptedChapters[0].content).toBe('ONLY_FINAL_REPAIR');
  });

  test('full revalidation catches a new HIGH class introduced by Repair 1', async () => {
    const run = await execute({
      count: 1,
      semanticResponses: [
        semantic(false, 'CHARACTER_SKILL_DRIFT'),
        semantic(false, 'CHRONOLOGY_CONTRADICTION'),
        semantic(true)
      ],
      repairResponses: [xml(7, 'REPAIR_ONE'), xml(7, 'REPAIR_TWO_SAFE')]
    });
    expect(run.result.success).toBe(true);
    expect(run.prompts.validator).toHaveLength(3);
    expect(run.result.acceptedChapters[0].content).toBe('REPAIR_TWO_SAFE');
  });

  test('malformed optional State Extractor fields use safe fallback without losing accepted chapters', async () => {
    const run = await execute({ count: 1, stateResponse: JSON.stringify({
      relationships: [{ characterA: 'Lan', characterB: { bad: true } }],
      chapterSummaries: [{ chapterNumber: 7, summary: { bad: true } }],
      authorOnlySecrets: [CANARIES[0]]
    }) });
    expect(run.result.success).toBe(true);
    expect(run.result.nextState.relationships).toEqual(run.currentState.relationships);
    expect(JSON.stringify(run.result.nextState)).not.toContain(CANARIES[0]);
    expect(run.result.nextMemories.some(memory => memory.chapterNumber === 7)).toBe(true);
  });

  test('failed batch leaves every persistent input collection byte-identical', async () => {
    const run = await execute({ count: 2, semanticResponses: [semantic(false, 'CHRONOLOGY_CONTRADICTION')], repairResponses: ['bad', 'bad'] });
    expect(run.result.success).toBe(false);
    expect(JSON.stringify({ chapters: run.chapters, state: run.currentState })).toBe(run.inputSnapshot);
    expect(run.result).toMatchObject({ acceptedChapters: [], newCharacters: [], newMemories: [] });
  });

  test('critical state integration failure returns STATE_DELTA_INVALID and no partial persistent mutation', async () => {
    const run = await execute({ count: 1, criticalStateFailure: true });
    expect(run.result.success).toBe(false);
    expect(run.result.acceptedChapters).toEqual([]);
    expect(run.result.newMemories).toEqual([]);
    expect(run.result.validationResult.violations.map(violation => violation.type)).toContain('STATE_DELTA_INVALID');
    expect(JSON.stringify({ chapters: run.chapters, state: run.currentState })).toBe(run.inputSnapshot);
  });
});

describe('Story Engine Task 5 - memory, import, sanity, routing, and UI acceptance', () => {
  test('long-story retrieval selects old seed, injury, debt, thread, and location within budget over recent noise', () => {
    const { control } = fixture();
    const durable: ChapterMemory[] = [
      { id: 'seed', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 12, title: 'Seed', summary: 'old unresolved seed', charactersInvolved: ['Lan'], locations: [], seedIds: ['old_seed'], importance: 90 },
      { id: 'injury', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 50, title: 'Injury', summary: 'active leg injury', charactersInvolved: ['Lan'], locations: [], injuryIds: ['leg_wound'], importance: 90 },
      { id: 'debt', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 80, title: 'Debt', summary: 'relationship debt', charactersInvolved: ['Witness'], locations: [], relationshipIds: ['lan###witness'], importance: 90 },
      { id: 'thread', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 100, title: 'Thread', summary: 'current thread at current location', charactersInvolved: ['Lan'], locations: ['Vinh district'], threadIds: ['river_mystery'], importance: 90 }
    ];
    const noise = Array.from({ length: 30 }, (_, index): ChapterMemory => ({
      id: `noise_${index}`, schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash,
      chapterNumber: 500 + index, title: 'Noise', summary: 'recent irrelevant event', charactersInvolved: [], locations: [], resolved: true, importance: 1
    }));
    const selected = retrieveRelevantMemories([...durable, ...noise], {
      currentChapter: 550, seedIds: ['old_seed'], injuryIds: ['leg_wound'], relationshipIds: ['lan###witness'],
      threadIds: ['river_mystery'], locations: ['Vinh district'], characterNames: ['Lan']
    }, 4);
    expect(selected.map(memory => memory.id).sort()).toEqual(['debt', 'injury', 'seed', 'thread']);
  });

  test('continuity compaction retains irreversible event and active injury but drops resolved low detail', () => {
    const { control } = fixture();
    const s = state(control, 500);
    const memories: ChapterMemory[] = [
      { id: 'death', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 1, title: 'Death', summary: 'mentor died', charactersInvolved: [], locations: [], irreversible: true, resolved: true },
      { id: 'injury', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 3, title: 'Injury', summary: 'leg injury', charactersInvolved: ['Lan'], locations: [], injuryIds: ['leg_wound'] },
      { id: 'resolved', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 4, title: 'Detail', summary: 'resolved low detail', charactersInvolved: [], locations: [], resolved: true, importance: 1 },
      { id: 'recent', schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: control.sourceHash, chapterNumber: 500, title: 'Recent', summary: 'recent event', charactersInvolved: [], locations: [], importance: 90 }
    ];
    expect(compactMemoryIndex(memories, 3, s).map(memory => memory.id)).toEqual(['death', 'injury', 'recent']);
  });

  test('AUTHOR_SETUP resets Project A completely and FULL_PROJECT only restores compatible derived data', () => {
    const previous: CreativeState = {
      prompt: '', chapters: existingChapters(3), summary: 'A summary', suggestions: ['A'], isGenerating: false,
      isSummarizing: false, targetChapters: 2, characters: [{ id: 'a', name: 'A', gender: '', age: '', role: '', appearance: '', personality: '' }]
    };
    const author = parseSetupFileContent(JSON.stringify({ seedTitle: 'Project B', genre: 'Romance', premise: 'B', characters: [] }))!;
    const reset = applySetupImport(previous, author);
    expect(reset.chapters).toEqual([]);
    expect(reset.storyState).toBeUndefined();
    expect(reset.memoryIndex).toBeUndefined();

    const { control } = fixture();
    const incompatible = parseSetupFileContent(JSON.stringify({
      importType: 'FULL_PROJECT', seedTitle: 'B', genre: 'Detective', premise: 'B', characters: [],
      storyControl: { ...control, sourceHash: control.sourceHash },
      storyState: { ...state(control, 7), sourceHash: 'wrong_hash' },
      memoryIndex: [{ schemaVersion: MEMORY_SCHEMA_VERSION, sourceHash: 'wrong_hash', chapterNumber: 7, title: 'bad', summary: CANARIES[0] }],
      chapters: [{ id: 'b1', chapterNumber: 1, title: 'B1', content: 'B prose' }]
    }))!;
    const restored = applySetupImport(previous, incompatible);
    expect(restored.chapters).toHaveLength(1);
    expect(restored.storyState).toBeUndefined();
    expect(restored.memoryIndex).toEqual([]);
  });

  test('strict 38-arc sanity fixture reports exact READY fields and a corrupted coverage property is BLOCKED', () => {
    const arcs = Array.from({ length: 38 }, (_, index) => ({
      id: `arc_${index + 1}`, title: `Arc ${index + 1}`, startChapter: index * 10 + 1,
      endChapter: index * 10 + 10, theme: `Theme ${index + 1}`, coreConflict: 'Conflict'
    }));
    const blueprint = validateBlueprintV3Object(rawBlueprint(arcs));
    const bible: StoryBible = {
      seedTitle: 'Long fixture', genre: 'Detective', seriesPremise: 'Safe', continuitySummary: '', worldNotes: '', charNotes: '', outline: '',
      characters: [{ id: 'hero', name: 'Lan', gender: '', age: '', role: 'lead', appearance: '', personality: '' }],
      totalPlannedChapters: 380, blueprintV3: blueprint, storyEngineSettingsV3: { readerSafePremise: 'Safe' }
    };
    const control = createStoryControlFromBlueprint(blueprint, computeBibleHash(bible), bible.storyEngineSettingsV3);
    const ready = runStoryEngineSanityCheck({ bible, control, modelAvailability: { FAST: true, QUALITY: true }, strict: true });
    expect(ready).toMatchObject({ pass: true, settingsLoaded: true, blueprintLoaded: true, arcCount: 38, exactArcCoverage: true, plannerContextLeakCheck: true, writerContextLeakCheck: true });
    const corrupt = { ...control, arcs: control.arcs.map((arc, index) => index === 1 ? { ...arc, startChapter: arc.startChapter + 1 } : arc) };
    expect(runStoryEngineSanityCheck({ bible, control: corrupt, modelAvailability: { FAST: true, QUALITY: true }, strict: true }).pass).toBe(false);
  });

  test('routing tiers are exercised centrally and no Story Engine production file embeds a direct model ID', async () => {
    const run = await execute({ count: 1, semanticResponses: [semantic(false, 'PLAN_VIOLATION'), semantic(true)] });
    const logs = run.logs.join('\n');
    expect(logs).toContain('role=PLANNER tier=FAST');
    expect(logs).toContain('role=PLAN_VALIDATOR_SEMANTIC tier=QUALITY');
    expect(logs).toContain('role=WRITER tier=QUALITY');
    expect(logs).toContain('role=STORY_VALIDATOR_SEMANTIC tier=QUALITY');
    expect(logs).toContain('role=AUTO_REPAIR tier=QUALITY');
    expect(logs).toContain('role=STATE_EXTRACTOR tier=FAST');
    const sourceDir = join(process.cwd(), 'src', 'services', 'storyEngine');
    const productionFiles = ['pipeline.ts', 'planner.ts', 'writer.ts', 'validator.ts', 'semanticValidator.ts', 'autoRepair.ts', 'stateExtractor.ts', 'memoryManager.ts', 'compiler.ts'];
    expect(productionFiles.filter(file => /gemini-\d/.test(readFileSync(join(sourceDir, file), 'utf8')))).toEqual([]);
  });

  test('UI has no Sanity bypass, renders status/chapters, and generic auto-fill prompt has no cultivation injection', () => {
    const page = readFileSync(join(process.cwd(), 'src', 'components', 'CreativePage.tsx'), 'utf8');
    const hook = readFileSync(join(process.cwd(), 'src', 'hooks', 'pages', 'useCreativePage.ts'), 'utf8');
    const generateButtons = [...page.matchAll(/onClick=\{handleGenerateCreativeChapters\}[\s\S]{0,220}?disabled=\{([^}]+)\}/g)];
    expect(generateButtons).toHaveLength(2);
    expect(generateButtons.every(match => match[1].includes('storyEngineSanity?.pass !== true'))).toBe(true);
    expect(page).toContain("'READY'");
    expect(page).toContain("'BLOCKED'");
    expect(page).toContain('state.chapters.map');
    expect(hook).not.toContain('chuyên gia thiết kế cốt truyện tiên hiệp');
    expect(hook).not.toContain('Hệ thống tu luyện');
  });
});
