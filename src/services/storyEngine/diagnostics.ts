import { getAllExposureRules, getCharacterAccess, getWorldFactGateChapter } from './storyAccess';
import { StoryControl, StoryValidationResult, StoryViolation } from './types';
import { formatChapterPacingTarget, getChapterPacingTarget } from './pacingContract';
import { redactProviderSecrets } from '../../utils/secretRedaction';

const HIDDEN_DETAIL = '[HIDDEN_DETAIL]';
const MAX_DIAGNOSTIC_TEXT_LENGTH = 600;

function collectSecretStrings(value: unknown, output = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (value.trim().length >= 4) output.add(value.trim());
  } else if (Array.isArray(value)) {
    value.forEach(item => collectSecretStrings(item, output));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach(item => collectSecretStrings(item, output));
  }
  return output;
}

export function collectHiddenStoryStrings(control: StoryControl, chapters: number[] = []): Set<string> {
  const secrets = collectSecretStrings(control.authorOnlySecrets || []);
  const targetChapter = chapters.length ? Math.max(...chapters) : undefined;
  for (const rawThread of control.mysteryThreads || []) {
    if (rawThread && typeof rawThread === 'object' && !Array.isArray(rawThread)) {
      collectSecretStrings((rawThread as Record<string, unknown>).actualTruth, secrets);
    }
  }
  for (const fact of control.worldFacts || []) {
    collectSecretStrings(fact.secretTruth, secrets);
    if (fact.visibility !== 'always' || fact.scope !== 'public' || getWorldFactGateChapter(fact) > 1) {
      collectSecretStrings(fact.fact, secrets);
    }
  }
  for (const gate of control.spoilerGates || []) collectSecretStrings(gate.description, secrets);
  for (const character of Object.values(control.characterRegistry || {})) {
    if (targetChapter === undefined) {
      // With no trustworthy chapter location, fail closed for logging and treat every profile as non-public.
      collectSecretStrings(character, secrets);
      continue;
    }
    const access = getCharacterAccess(control, character, targetChapter);
    if (!access.canMention) {
      collectSecretStrings(character, secrets);
    } else if (!access.canAppearDirectly) {
      collectSecretStrings({
        aliases: character.aliases,
        aliasSet: character.aliasSet,
        role: character.role,
        gender: character.gender,
        age: character.age,
        appearance: character.appearance,
        personality: character.personality,
        coreMotivation: character.coreMotivation,
        forbiddenSpoilers: character.forbiddenSpoilers,
        restrictions: character.restrictions
      }, secrets);
    }
  }
  for (const arc of control.arcs || []) {
    collectSecretStrings(arc.forbiddenSpoilers, secrets);
    if (targetChapter === undefined || arc.startChapter > targetChapter) collectSecretStrings(arc, secrets);
  }
  for (const rule of getAllExposureRules(control)) {
    collectSecretStrings(rule.forbiddenEvidence, secrets);
    collectSecretStrings(rule.forbiddenInferences, secrets);
  }
  return secrets;
}

export function redactHiddenStoryText(text: string | undefined, secrets: Set<string>): string | undefined {
  if (!text) return undefined;
  let safe = text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    safe = safe.replace(new RegExp(escaped, 'giu'), HIDDEN_DETAIL);
  }
  // Defense in depth: credentials are never valid QA evidence and must not reach persisted/exported logs.
  return redactProviderSecrets(safe);
}

function diagnosticText(text: string | undefined, secrets: Set<string>): string | undefined {
  const redacted = redactHiddenStoryText(text, secrets)?.replace(/\s+/g, ' ').trim();
  if (!redacted) return undefined;
  return redacted.length <= MAX_DIAGNOSTIC_TEXT_LENGTH
    ? redacted : `${redacted.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH - 1)}…`;
}

function diagnosticChapters(result: StoryValidationResult): number[] {
  const chapters = [...result.violations, ...(result.warnings || [])]
    .map(violation => violation.chapterNumber ?? violation.chapter)
    .filter((chapter): chapter is number => typeof chapter === 'number' && Number.isInteger(chapter) && chapter > 0);
  // Use the earliest affected chapter so later-unlocked data cannot leak into an earlier chapter's diagnostic.
  return chapters.length ? [Math.min(...chapters)] : [];
}

export function sanitizeStoryViolationForDiagnostics(
  violation: StoryViolation,
  secrets: Set<string>
): StoryViolation {
  const chapterNumber = violation.chapterNumber ?? violation.chapter;
  const message = diagnosticText(violation.message || violation.reason, secrets) || 'Story QA reported an issue.';
  const evidence = diagnosticText(violation.evidence || violation.quoteOrDescription, secrets);
  const suggestedRepair = diagnosticText(violation.suggestedRepair || violation.repairInstruction, secrets);
  const relatedRuleId = diagnosticText(violation.relatedRuleId, secrets);
  const relatedCharacter = diagnosticText(violation.relatedCharacter, secrets);
  const relatedThreadId = diagnosticText(violation.relatedThreadId, secrets);
  return {
    type: violation.type,
    severity: violation.severity,
    chapterNumber,
    message,
    evidence,
    suggestedRepair,
    relatedRuleId,
    relatedCharacter,
    relatedThreadId,
    chapter: chapterNumber,
    quoteOrDescription: evidence || message,
    reason: message,
    repairInstruction: suggestedRepair || ''
  };
}

export function sanitizeValidationResultForDiagnostics(
  result: StoryValidationResult,
  control: StoryControl
): StoryValidationResult {
  const secrets = collectHiddenStoryStrings(control, diagnosticChapters(result));
  return {
    ...result,
    violations: result.violations.map(violation => sanitizeStoryViolationForDiagnostics(violation, secrets)),
    warnings: (result.warnings || []).map(warning => sanitizeStoryViolationForDiagnostics(warning, secrets))
  };
}

export function formatSemanticQaDiagnosticLines(
  result: StoryValidationResult,
  control: StoryControl
): string[] {
  const safeResult = sanitizeValidationResultForDiagnostics(result, control);
  return [...safeResult.violations, ...(safeResult.warnings || [])].map(violation => {
    const lines = [
      '[Semantic QA Detail]',
      `chapter=${violation.chapterNumber ?? violation.chapter ?? 'unknown'}`,
      `type=${violation.type}`,
      `severity=${violation.severity}`,
      `message=${violation.message}`
    ];
    if (violation.evidence) lines.push(`evidence=${violation.evidence}`);
    if (violation.suggestedRepair) lines.push(`suggestedRepair=${violation.suggestedRepair}`);
    if (violation.relatedRuleId) lines.push(`relatedRuleId=${violation.relatedRuleId}`);
    if (violation.relatedCharacter) lines.push(`relatedCharacter=${violation.relatedCharacter}`);
    if (violation.relatedThreadId) lines.push(`relatedThreadId=${violation.relatedThreadId}`);
    if (violation.type === 'WORD_COUNT_DEFICIT' || violation.type === 'WORD_COUNT_EXCESS') {
      lines.push(`pacingTarget=${formatChapterPacingTarget(getChapterPacingTarget(control))}`);
    }
    return lines.join('\n');
  });
}
