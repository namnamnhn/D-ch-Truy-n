import { describe, expect, test } from 'vitest';
import { CreativeChapter } from '../src/types';
import { buildRepairPrompt, repairBatchOutput } from '../src/services/storyEngine/autoRepair';
import { createStoryControlFromBlueprint, validateBlueprintV3Object } from '../src/services/storyEngine/blueprintParser';
import { computeBibleHash } from '../src/services/storyEngine/compiler';
import { buildWriterContext } from '../src/services/storyEngine/contextBuilder';
import {
  createOutputLanguageContract,
  createWriterOutputLanguageContract,
  findUnexpectedScriptContamination
} from '../src/services/storyEngine/languageContract';
import {
  BatchPlan,
  ChapterPlan,
  StoryBible,
  StoryState,
  STORY_STATE_SCHEMA_VERSION
} from '../src/services/storyEngine/types';

const ACTIVE_NAME = 'Лан玄';
const FUTURE_NAME = 'Будущее Канарейка';
const FUTURE_ALIAS = '未来金丝雀';

function setup() {
  const settings = {
    strictOutputLanguage: true,
    canonicalProperNouns: [ACTIVE_NAME, FUTURE_NAME, FUTURE_ALIAS, 'API'],
    chapterWordTarget: { min: 1, ideal: 20, max: 100, soft: true, neverPadWithFiller: true }
  };
  const bible: StoryBible = {
    seedTitle: 'Gate-safe language fixture', genre: 'Mystery', seriesPremise: 'Safe premise.',
    continuitySummary: '', worldNotes: '', charNotes: '', outline: '', totalPlannedChapters: 8,
    storyEngineSettingsV3: settings,
    characters: [
      { id: 'active', name: ACTIVE_NAME, gender: '', age: '', role: 'lead', appearance: '', personality: '' },
      { id: 'future', name: FUTURE_NAME, gender: '', age: '', role: 'future', appearance: '', personality: '' }
    ]
  };
  const blueprint = validateBlueprintV3Object({
    totalChapters: 8, settings,
    characterRegistry: [
      {
        id: 'active', name: ACTIVE_NAME, aliasSet: [ACTIVE_NAME], role: 'lead', appearance: '', personality: '',
        restrictions: [], unlockChapter: 1, directAppearanceChapter: 1
      },
      {
        id: 'future', name: FUTURE_NAME, aliasSet: [FUTURE_ALIAS], role: 'future witness', appearance: '', personality: '',
        restrictions: [], unlockChapter: 5, directAppearanceChapter: 5
      }
    ],
    worldFacts: [], narrativeExposureRules: [], mysteryThreads: [], authorOnlySecrets: [],
    characterGates: [{
      characterId: 'future', characterName: FUTURE_NAME, unlockAtArcId: 'arc_2', unlockAtChapter: 5,
      prerequisiteClues: [], reason: 'Future identity gate.'
    }],
    spoilerGates: [],
    arcs: [
      {
        id: 'arc_1', title: 'Before gate', startChapter: 1, endChapter: 4, climaxChapter: 4,
        theme: 'search', coreConflict: 'unknown witness', pacing: 'slow_burn',
        unlockedCharacterIds: ['active'], keyMilestones: [], worldBuildingFocus: '', forbiddenSpoilers: []
      },
      {
        id: 'arc_2', title: 'After gate', startChapter: 5, endChapter: 8, climaxChapter: 8,
        theme: 'reveal witness', coreConflict: 'testimony', pacing: 'accelerating',
        unlockedCharacterIds: ['active', 'future'], keyMilestones: [], worldBuildingFocus: '', forbiddenSpoilers: []
      }
    ]
  });
  const control = createStoryControlFromBlueprint(blueprint, computeBibleHash(bible), settings);
  const state: StoryState = {
    schemaVersion: STORY_STATE_SCHEMA_VERSION, sourceHash: control.sourceHash, currentChapter: 0,
    characterStates: {}, relationships: [], resources: {}, clues: [], unresolvedThreads: [],
    longTermSeeds: [], recentConsequences: [], currentArcId: 'arc_1', currentArcProgress: 0,
    unlockedCharacterIds: ['active'], worldFactStates: {}
  };
  return { bible, control, state };
}

function chapterPlan(chapterNumber: number): ChapterPlan {
  return {
    chapterNumber, arcId: chapterNumber < 5 ? 'arc_1' : 'arc_2', title: `Chapter ${chapterNumber}`,
    focus: 'Follow the approved clue.', primaryGoal: 'Follow the approved clue.', povCharacter: ACTIVE_NAME,
    pacingTarget: 'rising_action', requiredEvents: [], introducedCharacters: [], activeCharacters: [ACTIVE_NAME],
    worldFactInteractions: [], cluesDiscovered: [], forbiddenSpoilers: [], plannedCharacters: [ACTIVE_NAME],
    plannedWorldFacts: [], plannedEvidence: [], plannedInferences: [], continuityRequirements: [], arcBeatIds: []
  };
}

function batch(chapterNumber: number): BatchPlan {
  return {
    arcId: chapterNumber < 5 ? 'arc_1' : 'arc_2', startChapter: chapterNumber, endChapter: chapterNumber,
    requestedChapterNumbers: [chapterNumber], chapters: [chapterPlan(chapterNumber)], batchDirectives: [],
    charactersGated: [], antiDriftMeasures: [], planValid: true
  };
}

function rejectedChapter(chapterNumber: number): CreativeChapter {
  return {
    id: `chapter_${chapterNumber}`, chapterNumber, title: `Chapter ${chapterNumber}: Test`,
    content: 'Safe rejected prose.', status: 'completed'
  };
}

describe('chapter-scoped Writer-safe language allowlisting', () => {
  test('A. pre-gate Writer context excludes future locked name and alias', () => {
    const { bible, control, state } = setup();
    const context = buildWriterContext(bible, control, batch(1), state, [], 1, 1, []);
    expect(context).toContain(ACTIVE_NAME);
    expect(context).not.toContain(FUTURE_NAME);
    expect(context).not.toContain(FUTURE_ALIAS);
  });

  test('B. AutoRepair Writer prompt and system instruction exclude future locked name and alias', async () => {
    const { bible, control, state } = setup();
    const writerContext = buildWriterContext(bible, control, batch(1), state, [], 1, 1, []);
    const safePrompt = buildRepairPrompt([rejectedChapter(1)], [{
      type: 'PLAN_VIOLATION', severity: 'HIGH', chapterNumber: 1, message: 'Safe repair issue.'
    }], writerContext, control);
    expect(safePrompt).not.toContain(FUTURE_NAME);
    expect(safePrompt).not.toContain(FUTURE_ALIAS);

    let repairInput = '';
    await repairBatchOutput([rejectedChapter(1)], '', [{
      type: 'PLAN_VIOLATION', severity: 'HIGH', chapterNumber: 1, message: 'Safe repair issue.'
    }], batch(1), writerContext, control, async (prompt, systemInstruction) => {
      repairInput = `${systemInstruction}\n${prompt}`;
      return '<CHAPTER number="1" title="Chapter 1: Repaired">Safe repaired prose.</CHAPTER>';
    }, bible);
    expect(repairInput).not.toContain(FUTURE_NAME);
    expect(repairInput).not.toContain(FUTURE_ALIAS);
  });

  test('C. after the gate, legal character name and alias may enter Writer context', () => {
    const { bible, control, state } = setup();
    const context = buildWriterContext(bible, control, batch(5), state, [], 5, 1, []);
    expect(context).toContain(FUTURE_NAME);
    expect(context).toContain(FUTURE_ALIAS);
  });

  test('D. currently visible Cyrillic/Han canonical name is allowlisted without a false positive', () => {
    const { bible, control } = setup();
    const contract = createWriterOutputLanguageContract(control, bible, 1);
    expect(contract.permittedForeignTerms).toContain(ACTIVE_NAME);
    expect(findUnexpectedScriptContamination(`${ACTIVE_NAME} bước vào.`, contract)).toEqual([]);
  });

  test('E. hidden future identities are not permitted by registry, Bible, or explicit author allowlist', () => {
    const { bible, control } = setup();
    const writerContract = createWriterOutputLanguageContract(control, bible, 1);
    expect(writerContract.permittedForeignTerms).toContain('API');
    expect(writerContract.permittedForeignTerms).not.toContain(FUTURE_NAME);
    expect(writerContract.permittedForeignTerms).not.toContain(FUTURE_ALIAS);
    expect(findUnexpectedScriptContamination(`${FUTURE_NAME} ${FUTURE_ALIAS}`, writerContract).length).toBeGreaterThan(0);

    // Validator-side authoritative checks may retain terms that Writer must never see.
    const validatorContract = createOutputLanguageContract(control, bible);
    expect(validatorContract.permittedForeignTerms).toEqual(expect.arrayContaining([FUTURE_NAME, FUTURE_ALIAS]));
  });
});
