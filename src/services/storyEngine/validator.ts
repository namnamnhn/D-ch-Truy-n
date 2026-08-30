import { CreativeChapter } from '../../types';
import {
  BatchPlan,
  JsonValue,
  StoryBible,
  StoryControl,
  StoryState,
  StoryValidationResult,
  StoryViolation
} from './types';
import { lintChapterProse } from './styleLinter';
import { filterCharactersForChapter, filterSpoilersForChapter } from './arcController';
import { buildValidatorContext } from './contextBuilder';
import { getCharacterAccess, projectExposureRules, projectWorldFactsForChapter } from './storyAccess';
import {
  canonicalizeStoryValidation,
  makeStoryViolation,
  qaUnavailableResult,
  runSemanticValidation,
  SemanticRunner
} from './semanticValidator';
import { countProseWords } from './writer';
import { createOutputLanguageContract, findUnexpectedScriptContamination } from './languageContract';
import {
  createEmptyInBatchContinuityLock,
  extendInBatchContinuityLock,
  findConcreteFactContradictions
} from './continuityLock';
import { getChapterPacingTarget } from './pacingContract';

function configuredBoolean(control: StoryControl, key: string): boolean {
  const value = control.settings?.[key];
  return value === true;
}

function configuredNumber(control: StoryControl, key: string): number | undefined {
  const value = control.settings?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectConfiguredStrings(value: JsonValue | undefined, keys: Set<string>, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectConfiguredStrings(item, keys, output);
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(key.toLocaleLowerCase('en-US')) && Array.isArray(child)) {
      for (const item of child) if (typeof item === 'string' && item.trim()) output.add(item.trim());
    }
    collectConfiguredStrings(child, keys, output);
  }
  return output;
}

function containsConfiguredText(content: string, configured: string): boolean {
  return configured.length >= 2
    && content.toLocaleLowerCase('vi-VN').includes(configured.toLocaleLowerCase('vi-VN'));
}

function chapterNumberOf(chapter: CreativeChapter, fallback: number): number {
  return chapter.chapterNumber || fallback;
}

function deterministicViolation(input: Parameters<typeof makeStoryViolation>[0]): StoryViolation {
  return makeStoryViolation(input);
}

export function validateDeterministicBatchOutput(
  chapters: CreativeChapter[],
  batchPlan: BatchPlan,
  control: StoryControl,
  state: StoryState,
  bible: StoryBible
): StoryValidationResult {
  const violations: StoryViolation[] = [];
  const warnings: StoryViolation[] = [];
  const requested = batchPlan.requestedChapterNumbers || batchPlan.chapters.map(chapter => chapter.chapterNumber);
  const forbiddenProperNouns = collectConfiguredStrings(control.settings, new Set(['forbiddenpropernouns']));
  collectConfiguredStrings(control.originality, new Set(['forbiddenpropernouns']), forbiddenProperNouns);
  const bannedPhrases = collectConfiguredStrings(control.settings, new Set([
    'bannedphrases', 'forbiddenphrases', 'explicitbannedphrases'
  ]));
  collectConfiguredStrings(control.originality, new Set([
    'bannedphrases', 'forbiddenphrases', 'explicitbannedphrases'
  ]), bannedPhrases);
  const outputLanguage = createOutputLanguageContract(control, bible);
  const pacingTarget = getChapterPacingTarget(control);
  let continuityLock = createEmptyInBatchContinuityLock();

  const actualNumbers = chapters.map((chapter, index) => chapterNumberOf(chapter, batchPlan.startChapter + index));
  if (actualNumbers.length !== requested.length
    || requested.some(number => !actualNumbers.includes(number))
    || new Set(actualNumbers).size !== actualNumbers.length) {
    violations.push(deterministicViolation({
      type: 'OUTPUT_STRUCTURE', severity: 'CRITICAL', chapterNumber: batchPlan.startChapter,
      message: `Generated batch does not contain the exact requested chapters [${requested.join(', ')}].`,
      suggestedRepair: 'Regenerate the exact requested chapter envelopes.'
    }));
  }

  const lintResult = lintChapterProse(chapters, []);
  for (const issue of lintResult.violations) {
    warnings.push(deterministicViolation({
      type: 'ORIGINALITY_VIOLATION', severity: 'LOW', chapterNumber: batchPlan.startChapter,
      message: 'Configured prose/style lint reported an issue.', evidence: issue,
      suggestedRepair: 'Normalize the affected prose without changing story facts.'
    }));
  }

  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index];
    const chapterNumber = chapterNumberOf(chapter, batchPlan.startChapter + index);
    const content = chapter.content || '';
    const plan = batchPlan.chapters.find(candidate => candidate.chapterNumber === chapterNumber);
    if (!plan) {
      violations.push(deterministicViolation({
        type: 'PLAN_VIOLATION', severity: 'CRITICAL', chapterNumber,
        message: 'No approved ChapterPlan exists for this generated chapter.',
        suggestedRepair: 'Stop and regenerate an approved plan before writing.'
      }));
    }
    if (!content.trim() || /<\/?(?:SYSTEM|CONTROL|METADATA|STORY_CONTROL)\b/i.test(content)) {
      violations.push(deterministicViolation({
        type: 'OUTPUT_STRUCTURE', severity: 'CRITICAL', chapterNumber,
        message: 'Chapter prose is empty or contains leaked control metadata.',
        evidence: content.slice(0, 160), suggestedRepair: 'Return prose only inside the chapter envelope.'
      }));
    }

    const { lockedCharacters } = filterCharactersForChapter(
      bible.characters || [], control.characterGates || [], chapterNumber, control
    );
    const lockedNames = new Map(lockedCharacters.map(character => [character.characterName, character.unlockAtChapter]));
    for (const character of Object.values(control.characterRegistry || {})) {
      const access = getCharacterAccess(control, character, chapterNumber);
      if (!access.canAppearDirectly) lockedNames.set(character.name, access.directAppearanceChapter);
    }
    for (const [name, unlockChapter] of lockedNames) {
      if (!name || name.length < 2 || !containsConfiguredText(content, name)) continue;
      violations.push(deterministicViolation({
        type: 'CHARACTER_GATE', severity: 'HIGH', chapterNumber,
        message: `A character appears before the direct-appearance gate at chapter ${unlockChapter}.`,
        evidence: name, relatedCharacter: name,
        suggestedRepair: 'Remove the premature direct appearance or use an approved present character.'
      }));
    }

    const { forbiddenSpoilers } = filterSpoilersForChapter(control.spoilerGates || [], chapterNumber);
    for (const spoiler of forbiddenSpoilers) {
      if (!containsConfiguredText(content, spoiler.description)) continue;
      violations.push(deterministicViolation({
        type: 'SPOILER_LEAK', severity: 'HIGH', chapterNumber,
        message: `An explicitly gated spoiler appears before chapter ${spoiler.forbiddenBeforeChapter}.`,
        evidence: spoiler.description, relatedRuleId: spoiler.id,
        suggestedRepair: 'Remove the explicit reveal and preserve uncertainty.'
      }));
    }

    const exposure = projectExposureRules(control, chapterNumber, true);
    for (const forbiddenEvidence of exposure.forbiddenEvidence) {
      if (!containsConfiguredText(content, forbiddenEvidence)) continue;
      violations.push(deterministicViolation({
        type: 'PREMATURE_EVIDENCE', severity: 'HIGH', chapterNumber,
        message: 'Prose directly includes evidence forbidden by the active exposure gate.',
        evidence: forbiddenEvidence,
        relatedRuleId: exposure.ruleIds.join(','),
        suggestedRepair: 'Remove the forbidden evidence while retaining only evidence allowed at this chapter.'
      }));
    }
    for (const forbiddenInference of exposure.forbiddenInferences) {
      if (!containsConfiguredText(content, forbiddenInference)) continue;
      violations.push(deterministicViolation({
        type: 'PREMATURE_INFERENCE', severity: 'HIGH', chapterNumber,
        message: 'Prose explicitly states an inference forbidden by the active exposure gate.',
        evidence: forbiddenInference,
        relatedRuleId: exposure.ruleIds.join(','),
        suggestedRepair: 'Keep the conclusion at the permitted level of suspicion.'
      }));
    }

    for (const fact of projectWorldFactsForChapter(control, chapterNumber).locked) {
      if (fact.id.length < 4 || !containsConfiguredText(content, fact.id)) continue;
      violations.push(deterministicViolation({
        type: 'WORLD_FACT_GATE_VIOLATION', severity: 'HIGH', chapterNumber,
        message: 'Chapter prose contains the exact identifier of a locked world fact.',
        evidence: fact.id, relatedRuleId: fact.id,
        suggestedRepair: 'Remove the locked fact reference and use only currently available world knowledge.'
      }));
    }

    for (const properNoun of forbiddenProperNouns) {
      if (!containsConfiguredText(content, properNoun)) continue;
      violations.push(deterministicViolation({
        type: 'REAL_WORLD_CONTAMINATION', severity: 'HIGH', chapterNumber,
        message: 'Chapter prose contains an explicitly forbidden proper noun.',
        evidence: properNoun,
        suggestedRepair: 'Replace the reference with world-native material consistent with the approved plan.'
      }));
    }
    for (const phrase of bannedPhrases) {
      if (!containsConfiguredText(content, phrase)) continue;
      violations.push(deterministicViolation({
        type: 'ORIGINALITY_VIOLATION', severity: 'MEDIUM', chapterNumber,
        message: 'Chapter prose contains an explicitly banned phrase.', evidence: phrase,
        suggestedRepair: 'Rewrite the sentence in a specific, world-native voice.'
      }));
    }

    for (const finding of findUnexpectedScriptContamination(content, outputLanguage)) {
      violations.push(deterministicViolation({
        type: 'REAL_WORLD_CONTAMINATION', severity: 'HIGH', chapterNumber,
        message: `Chapter prose contains unexpected ${finding.script} script outside the configured language allowance.`,
        evidence: finding.fragment,
        suggestedRepair: 'Replace the contaminating fragment with natural target-language prose without changing story facts.'
      }));
    }

    for (const contradiction of findConcreteFactContradictions(continuityLock, chapter)) {
      violations.push(deterministicViolation({
        type: 'FACT_CONTRADICTION', severity: 'HIGH', chapterNumber,
        message: `An established concrete fact changed without an explicit story event: ${contradiction.established.subject}.${contradiction.established.predicate}.`,
        evidence: contradiction.conflicting.evidence,
        suggestedRepair: `Preserve the earlier established value ${contradiction.established.value}${contradiction.established.unit ? ` ${contradiction.established.unit}` : ''} and modify only the conflicting later prose unless the approved plan requires a change event.`
      }));
    }

    const wordCount = countProseWords(content);
    const minimum = pacingTarget.min;
    if (wordCount < minimum) {
      const target = pacingTarget.soft ? warnings : violations;
      target.push(deterministicViolation({
        type: 'WORD_COUNT_DEFICIT', severity: pacingTarget.soft ? 'LOW' : 'HIGH', chapterNumber,
        message: `Chapter has ${wordCount} words; configured minimum is ${minimum}.`,
        suggestedRepair: 'Expand the existing approved plan through action, sensory detail, dialogue, reasoning, character interaction, tactical friction, environment, and consequences. Do not add filler, duplicate exposition, a new major plot beat, or a premature reveal.'
      }));
    }
    if (wordCount > pacingTarget.max) {
      violations.push(deterministicViolation({
        type: 'WORD_COUNT_EXCESS', severity: 'HIGH', chapterNumber,
        message: `Chapter has ${wordCount} words; configured maximum is ${pacingTarget.max}.`,
        suggestedRepair: 'Tighten the approved scenes without removing required events or continuity facts.'
      }));
    }
    if (plan) continuityLock = extendInBatchContinuityLock(continuityLock, chapter, plan);
  }

  const activeInjuries = Object.values(state.characterStates || {}).flatMap(characterState =>
    (characterState.injuries || [])
      .filter(injury => injury.status !== 'recovered'
        && (injury.severity === 'severe' || injury.severity === 'critical'))
      .map(injury => ({ name: characterState.name, injury }))
  );
  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index];
    const chapterNumber = chapterNumberOf(chapter, batchPlan.startChapter + index);
    const content = chapter.content || '';
    for (const { name, injury } of activeInjuries) {
      if (!containsConfiguredText(content, name)) continue;
      const combat = /(?:xuất toàn lực|nhảy vọt lên|vung kiếm chém mạnh|tung quyền như vũ bão|phi thân tốc biến)/iu;
      if (combat.test(content) && !/(?:vết thương|đau)/iu.test(content)) {
        violations.push(deterministicViolation({
          type: 'INJURY_AMNESIA', severity: 'HIGH', chapterNumber,
          message: `A severe injury is still active; recovery chapter ${injury.expectedRecoveryChapter} was only an expectation.`,
          relatedCharacter: name,
          suggestedRepair: 'Show the movement restriction, pain, tactical limitation, or credible cost.'
        }));
      }
    }
  }

  return canonicalizeStoryValidation(true, violations, warnings, {
    strictLowSeverity: configuredBoolean(control, 'strictLowSeverity')
  });
}

export function mergeValidationLayers(
  deterministic: StoryValidationResult,
  semantic: StoryValidationResult,
  control: StoryControl
): StoryValidationResult {
  if (semantic.status === 'QA_UNAVAILABLE') {
    return {
      ...semantic,
      violations: [...deterministic.violations, ...semantic.violations],
      warnings: [...(deterministic.warnings || []), ...(semantic.warnings || [])]
    };
  }
  const merged = canonicalizeStoryValidation(
    deterministic.pass && semantic.pass,
    [...deterministic.violations, ...semantic.violations],
    [...(deterministic.warnings || []), ...(semantic.warnings || [])],
    { strictLowSeverity: configuredBoolean(control, 'strictLowSeverity'), attempts: semantic.attempts }
  );
  return { ...merged, modelRole: semantic.modelRole };
}

export async function validateBatchOutput(
  chapters: CreativeChapter[],
  batchPlan: BatchPlan,
  control: StoryControl,
  state: StoryState,
  bible: StoryBible,
  runner?: SemanticRunner,
  priorChapters: CreativeChapter[] = [],
  signal?: AbortSignal,
): Promise<StoryValidationResult> {
  try {
    const deterministic = validateDeterministicBatchOutput(chapters, batchPlan, control, state, bible);
    const prompt = buildValidatorContext(control, batchPlan, state, batchPlan.startChapter, chapters, priorChapters);
    const semantic = await runSemanticValidation(prompt, runner, {
      maxAttempts: 2,
      timeoutMs: configuredNumber(control, 'semanticQaTimeoutMs'),
      strictLowSeverity: configuredBoolean(control, 'strictLowSeverity'), signal
    });
    return mergeValidationLayers(deterministic, semantic, control);
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    return qaUnavailableResult(0, 'Story QA infrastructure failed before a trustworthy verdict was produced.');
  }
}
