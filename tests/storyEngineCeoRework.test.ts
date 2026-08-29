import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { CreativeChapter } from '../src/types';
import {
  BatchPlan,
  ChapterPlan,
  JsonObject,
  StoryBible,
  StoryModelRole,
  StoryState,
  STORY_STATE_SCHEMA_VERSION
} from '../src/services/storyEngine/types';
import { validateBlueprintV3Object, createStoryControlFromBlueprint } from '../src/services/storyEngine/blueprintParser';
import { computeBibleHash } from '../src/services/storyEngine/compiler';
import { createOutputLanguageContract, findUnexpectedScriptContamination } from '../src/services/storyEngine/languageContract';
import { formatChapterPacingTarget, getChapterPacingTarget } from '../src/services/storyEngine/pacingContract';
import { generateChaptersProse, validateWriterOutput, WriterOutputValidationError } from '../src/services/storyEngine/writer';
import { validateDeterministicBatchOutput } from '../src/services/storyEngine/validator';
import { formatSemanticQaDiagnosticLines } from '../src/services/storyEngine/diagnostics';
import { canonicalizeStoryValidation } from '../src/services/storyEngine/semanticValidator';
import { repairBatchOutput } from '../src/services/storyEngine/autoRepair';
import { runStoryEnginePipeline } from '../src/services/storyEngine/pipeline';

// Exact production settings shape relevant to this rework: there is no
// outputLanguage, strictOutputLanguage, or enforceOutputLanguage key.
const PRODUCTION_SETTINGS = {
  chapterWordTarget: {
    min: 2200,
    ideal: 2700,
    max: 3400,
    soft: true,
    neverPadWithFiller: true
  }
};

function fixture(settings: JsonObject = PRODUCTION_SETTINGS) {
  const bible: StoryBible = {
    seedTitle: 'Production V3 shape', genre: 'Mystery', seriesPremise: 'A safe premise.',
    continuitySummary: '', worldNotes: '', charNotes: '', outline: '', characters: [],
    totalPlannedChapters: 1, storyEngineSettingsV3: settings
  };
  const blueprint = validateBlueprintV3Object({
    totalChapters: 1,
    settings,
    characterRegistry: [], worldFacts: [], narrativeExposureRules: [], mysteryThreads: [],
    characterGates: [], spoilerGates: [], authorOnlySecrets: [],
    arcs: [{
      id: 'arc_1', title: 'Opening', startChapter: 1, endChapter: 1, climaxChapter: 1,
      theme: 'evidence', coreConflict: 'investigate', pacing: 'rising_action',
      unlockedCharacterIds: [], keyMilestones: [], worldBuildingFocus: '', forbiddenSpoilers: []
    }]
  });
  const control = createStoryControlFromBlueprint(blueprint, computeBibleHash(bible), settings);
  const state: StoryState = {
    schemaVersion: STORY_STATE_SCHEMA_VERSION, sourceHash: control.sourceHash, currentChapter: 0,
    characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [],
    longTermSeeds: [], recentConsequences: [], currentArcId: 'arc_1', currentArcProgress: 0,
    unlockedCharacterIds: [], worldFactStates: {}
  };
  return { bible, control, state };
}

function chapterPlan(): ChapterPlan {
  return {
    chapterNumber: 1, arcId: 'arc_1', title: 'Chapter 1', focus: 'Investigate.',
    primaryGoal: 'Investigate.', povCharacter: 'Observer', pacingTarget: 'rising_action', requiredEvents: [],
    introducedCharacters: [], activeCharacters: [], worldFactInteractions: [], cluesDiscovered: [],
    forbiddenSpoilers: [], plannedCharacters: [], plannedWorldFacts: [], plannedEvidence: [],
    plannedInferences: [], continuityRequirements: [], arcBeatIds: []
  };
}

function batchPlan(): BatchPlan {
  const chapter = chapterPlan();
  return {
    arcId: 'arc_1', startChapter: 1, endChapter: 1, requestedChapterNumbers: [1], chapters: [chapter],
    batchDirectives: [], charactersGated: [], antiDriftMeasures: [], planValid: true
  };
}

function prose(content: string): CreativeChapter {
  return { id: 'chapter_1', chapterNumber: 1, title: 'Chapter 1: Test', content, status: 'completed' };
}

function xml(content: string): string {
  return `<CHAPTER number="1" title="Chapter 1: Test">${content}</CHAPTER>`;
}

describe('CEO rework - real one-file language contract', () => {
  test('production V3 settings without an explicit language key default to strict Vietnamese protection', () => {
    const { bible, control } = fixture();
    const contract = createOutputLanguageContract(control, bible);
    expect(contract).toMatchObject({ targetLanguage: 'Vietnamese', strict: true, allowedScripts: ['LATIN'] });
    expect(findUnexpectedScriptContamination('Văn xuôi внезапно đổi chữ.', contract))
      .toEqual(expect.arrayContaining([expect.objectContaining({ script: 'CYRILLIC', fragment: 'внезапно' })]));
    expect(findUnexpectedScriptContamination('Văn xuôi chứa 规定 lạ.', contract))
      .toEqual(expect.arrayContaining([expect.objectContaining({ script: 'HAN', fragment: '规定' })]));
  });

  test('canonical foreign terms remain allowlisted under the safe default', () => {
    const settings = { ...PRODUCTION_SETTINGS, canonicalProperNouns: ['Лан Canon', '规定'] };
    const { bible, control } = fixture(settings);
    expect(findUnexpectedScriptContamination('Лан Canon dùng 规定 đã duyệt.', createOutputLanguageContract(control, bible))).toEqual([]);
  });

  test('only explicit multilingual mode or boolean opt-out disables strict script guard', () => {
    const multilingual = fixture({ ...PRODUCTION_SETTINGS, multilingualOutput: true });
    const optedOut = fixture({ ...PRODUCTION_SETTINGS, strictOutputLanguage: false });
    expect(createOutputLanguageContract(multilingual.control, multilingual.bible).strict).toBe(false);
    expect(createOutputLanguageContract(optedOut.control, optedOut.bible).strict).toBe(false);
  });
});

describe('CEO rework - authoritative chapterWordTarget', () => {
  test('StoryControl centrally normalizes exact 2200/2700/3400 production pacing', () => {
    const { control } = fixture();
    expect(control.pacingRules).toMatchObject({
      minWordsPerChapter: 2200, idealWordsPerChapter: 2700, maxWordsPerChapter: 3400,
      softMinimumWords: true, neverPadWithFiller: true
    });
    expect(getChapterPacingTarget(control)).toEqual({ min: 2200, ideal: 2700, max: 3400, soft: true, neverPadWithFiller: true });
  });

  test('soft=true makes min advisory while max remains hard', () => {
    const { bible, control, state } = fixture();
    expect(() => validateWriterOutput(xml('short safe prose'), [1], {
      minimumWords: 2200, idealWords: 2700, maximumWords: 3400,
      softMinimumWords: true, neverPadWithFiller: true
    })).not.toThrow();
    const short = validateDeterministicBatchOutput([prose('short safe prose')], batchPlan(), control, state, bible);
    expect(short.violations.map(item => item.type)).not.toContain('WORD_COUNT_DEFICIT');
    expect(short.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'WORD_COUNT_DEFICIT', severity: 'LOW' })
    ]));
    const tooLong = Array.from({ length: 3401 }, () => 'word').join(' ');
    expect(() => validateWriterOutput(xml(tooLong), [1], {
      minimumWords: 2200, idealWords: 2700, maximumWords: 3400, softMinimumWords: true
    })).toThrow(WriterOutputValidationError);
    expect(validateDeterministicBatchOutput([prose(tooLong)], batchPlan(), control, state, bible)
      .violations.map(item => item.type)).toContain('WORD_COUNT_EXCESS');
  });

  test('Writer, Repair, and diagnostics preserve the normalized target and never-pad instruction', async () => {
    const { control } = fixture();
    let writerInstruction = '';
    await generateChaptersProse('safe context', batchPlan(), async (_prompt, systemInstruction) => {
      writerInstruction = systemInstruction;
      return xml('short safe prose');
    }, {
      minimumWords: 2200, idealWords: 2700, maximumWords: 3400,
      softMinimumWords: true, neverPadWithFiller: true
    });
    expect(writerInstruction).toContain('target 2700');
    expect(writerInstruction).toContain('soft/advisory minimum 2200');
    expect(writerInstruction).toContain('hard maximum 3400');
    expect(writerInstruction).toContain('NEVER pad');

    let repairInstruction = '';
    await repairBatchOutput([prose('short')], '', [{
      type: 'PLAN_VIOLATION', severity: 'HIGH', chapterNumber: 1, message: 'safe issue'
    }], batchPlan(), 'safe context', control, async (_prompt, systemInstruction) => {
      repairInstruction = systemInstruction;
      return xml('short repaired prose');
    });
    expect(repairInstruction).toContain(formatChapterPacingTarget(getChapterPacingTarget(control)));
    expect(repairInstruction).toContain('Never pad with filler');

    const diagnostic = formatSemanticQaDiagnosticLines(canonicalizeStoryValidation(true, [], [{
      type: 'WORD_COUNT_DEFICIT', severity: 'LOW', chapterNumber: 1, message: 'short'
    }]), control).join('\n');
    expect(diagnostic).toContain('pacingTarget=min=2200 ideal=2700 max=3400 soft=true neverPadWithFiller=true');
  });
});

describe('CEO rework - role-aware runtime routing', () => {
  test('pipeline dispatches each QUALITY operation with its real StoryModelRole', async () => {
    const { bible, control, state } = fixture();
    const roles: StoryModelRole[] = [];
    let semanticCalls = 0;
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: state, existingChapters: [], batchSize: 1,
      storyModelAvailability: { FAST: true, QUALITY: true },
      aiRoleRunner: async (role) => {
        roles.push(role);
        if (role === 'PLANNER') return JSON.stringify({ chapters: [chapterPlan()] });
        if (role === 'PLAN_VALIDATOR_SEMANTIC') return JSON.stringify({ pass: true, violations: [] });
        if (role === 'WRITER' || role === 'AUTO_REPAIR') return xml('short safe prose');
        if (role === 'STORY_VALIDATOR_SEMANTIC') {
          semanticCalls++;
          return semanticCalls === 1
            ? JSON.stringify({ pass: false, violations: [{ type: 'PLAN_VIOLATION', severity: 'HIGH', chapterNumber: 1, message: 'repair me' }] })
            : JSON.stringify({ pass: true, violations: [] });
        }
        return '{}';
      }
    });
    expect(result.success).toBe(true);
    expect(roles).toEqual(expect.arrayContaining([
      'WRITER', 'PLAN_VALIDATOR_SEMANTIC', 'STORY_VALIDATOR_SEMANTIC', 'AUTO_REPAIR'
    ]));
  });

  test('missing QUALITY never silently falls back to FAST', async () => {
    const { bible, control, state } = fixture();
    const roles: StoryModelRole[] = [];
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: state, existingChapters: [], batchSize: 1,
      storyModelAvailability: { FAST: true, QUALITY: false },
      aiRoleRunner: async role => { roles.push(role); return '{}'; }
    });
    expect(result.validationResult.status).toBe('QA_UNAVAILABLE');
    expect(result.acceptedChapters).toEqual([]);
    expect(roles).toEqual([]);
  });

  test('exhausted semantic QUALITY remains fail-closed with zero accepted chapters', async () => {
    const { bible, control, state } = fixture();
    const result = await runStoryEnginePipeline({
      bible, existingControl: control, existingState: state, existingChapters: [], batchSize: 1,
      storyModelAvailability: { FAST: true, QUALITY: true },
      aiRoleRunner: async (role) => {
        if (role === 'PLANNER') return JSON.stringify({ chapters: [chapterPlan()] });
        if (role === 'PLAN_VALIDATOR_SEMANTIC') return JSON.stringify({ pass: true, violations: [] });
        if (role === 'WRITER') return xml('short safe prose');
        if (role === 'STORY_VALIDATOR_SEMANTIC') throw new Error('all QUALITY candidates exhausted');
        return '{}';
      }
    });
    expect(result.validationResult.status).toBe('QA_UNAVAILABLE');
    expect(result.acceptedChapters).toEqual([]);
  });

  test('production UI resolves candidates from the live role instead of a cached WRITER route', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'hooks', 'pages', 'useCreativePage.ts'), 'utf8');
    expect(source).toContain('getStoryModelCandidates(role, IS_LITE)');
    expect(source).not.toContain("const proCandidates = [...getStoryModelCandidates('WRITER'");
  });
});
