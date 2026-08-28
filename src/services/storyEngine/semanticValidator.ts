import {
  STORY_VIOLATION_TYPES,
  StoryValidationResult,
  StoryViolation,
  StoryViolationSeverity,
  StoryViolationType
} from './types';
import { isRecord, normalizePositiveInteger, normalizeText, stripJsonFence } from './runtimeValidation';

export const SEMANTIC_VALIDATOR_MODEL_ROLE = 'semantic-validator' as const;
export const MAX_SEMANTIC_ATTEMPTS = 2;
export const DEFAULT_SEMANTIC_TIMEOUT_MS = 60_000;

export type SemanticRunner = (prompt: string, systemInstruction: string) => Promise<string>;

const violationTypes = new Set<string>(STORY_VIOLATION_TYPES);

function isStoryViolationType(value: string): value is StoryViolationType {
  return violationTypes.has(value);
}

interface ParsedSemanticResult {
  pass: boolean;
  violations: StoryViolation[];
  warnings: StoryViolation[];
}

function semanticChecksFor(violations: StoryViolation[]) {
  const types = new Set(violations.map(violation => violation.type));
  return {
    characterGating: !types.has('CHARACTER_GATE'),
    worldFactContinuity: !types.has('WORLD_FACT_CONTRADICTION')
      && !types.has('WORLD_FACT_GATE_VIOLATION')
      && !types.has('LOCATION_CANON_CONTRADICTION'),
    spoilerContainment: !types.has('SPOILER_LEAK')
      && !types.has('PREMATURE_EVIDENCE')
      && !types.has('PREMATURE_INFERENCE')
      && !types.has('READER_KNOWLEDGE_OVEREXPOSURE')
      && !types.has('PREMATURE_MYSTERY_RESOLUTION'),
    pacingIntegrity: !types.has('PACING_RUSH'),
    characterTraitConsistency: !types.has('CHARACTER_OOC')
      && !types.has('CHARACTER_SKILL_DRIFT')
      && !types.has('COMBAT_POWER_VIOLATION')
  };
}

function scoresFor(violations: StoryViolation[]): { continuityScore: number; pacingScore: number } {
  const penalty = violations.reduce((total, violation) => total + (
    violation.severity === 'CRITICAL' ? 35
      : violation.severity === 'HIGH' ? 25
        : violation.severity === 'MEDIUM' ? 12 : 2
  ), 0);
  return {
    continuityScore: Math.max(0, 100 - penalty),
    pacingScore: Math.max(0, 100 - violations.filter(violation =>
      violation.type === 'PACING_RUSH' || violation.type === 'PLAN_VIOLATION').length * 15)
  };
}

export function makeStoryViolation(input: {
  type: StoryViolationType;
  severity: StoryViolationSeverity;
  chapterNumber?: number;
  message: string;
  evidence?: string;
  relatedRuleId?: string;
  relatedCharacter?: string;
  relatedThreadId?: string;
  suggestedRepair?: string;
}): StoryViolation {
  return {
    ...input,
    chapter: input.chapterNumber,
    quoteOrDescription: input.evidence || input.message,
    reason: input.message,
    repairInstruction: input.suggestedRepair || ''
  };
}

function parseViolation(value: unknown, context: string): StoryViolation {
  if (!isRecord(value)) throw new Error(`${context} must be an object.`);
  const canonicalType = normalizeText(value.type)?.toLocaleUpperCase('en-US');
  if (!canonicalType || !isStoryViolationType(canonicalType)) {
    throw new Error(`${context}.type is not a supported StoryViolationType.`);
  }
  const canonicalSeverity = normalizeText(value.severity)?.toLocaleUpperCase('en-US');
  if (canonicalSeverity !== 'LOW' && canonicalSeverity !== 'MEDIUM'
    && canonicalSeverity !== 'HIGH' && canonicalSeverity !== 'CRITICAL') {
    throw new Error(`${context}.severity must be LOW, MEDIUM, HIGH, or CRITICAL.`);
  }
  const message = normalizeText(value.message);
  if (!message) throw new Error(`${context}.message must be a non-empty string.`);
  const optionalText = (key: string): string | undefined => {
    if (value[key] === undefined) return undefined;
    const text = normalizeText(value[key]);
    if (!text) throw new Error(`${context}.${key} must be a non-empty string when present.`);
    return text;
  };
  const chapterNumber = value.chapterNumber === undefined
    ? undefined : normalizePositiveInteger(value.chapterNumber) || undefined;
  if (value.chapterNumber !== undefined && chapterNumber === undefined) {
    throw new Error(`${context}.chapterNumber must be a positive integer when present.`);
  }
  return makeStoryViolation({
    type: canonicalType,
    severity: canonicalSeverity,
    chapterNumber,
    message,
    evidence: optionalText('evidence'),
    relatedRuleId: optionalText('relatedRuleId'),
    relatedCharacter: optionalText('relatedCharacter'),
    relatedThreadId: optionalText('relatedThreadId'),
    suggestedRepair: optionalText('suggestedRepair')
  });
}

export function parseSemanticValidationResponse(raw: string): ParsedSemanticResult {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Semantic QA returned an empty response.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(raw));
  } catch {
    throw new Error('Semantic QA returned invalid JSON.');
  }
  if (!isRecord(parsed)) throw new Error('Semantic QA root must be an object.');
  if (typeof parsed.pass !== 'boolean') throw new Error('Semantic QA pass must be boolean.');
  if (!Array.isArray(parsed.violations)) throw new Error('Semantic QA violations must be an array.');
  if (parsed.warnings !== undefined && !Array.isArray(parsed.warnings)) {
    throw new Error('Semantic QA warnings must be an array when present.');
  }
  return {
    pass: parsed.pass,
    violations: parsed.violations.map((violation, index) => parseViolation(violation, `violations[${index}]`)),
    warnings: Array.isArray(parsed.warnings)
      ? parsed.warnings.map((warning, index) => parseViolation(warning, `warnings[${index}]`)) : []
  };
}

export function canonicalizeStoryValidation(
  parsedPass: boolean,
  inputViolations: StoryViolation[],
  inputWarnings: StoryViolation[] = [],
  options: { strictLowSeverity?: boolean; attempts?: number } = {}
): StoryValidationResult {
  const all = [...inputViolations, ...inputWarnings];
  const warnings = all.filter(violation => violation.severity === 'LOW');
  const violations = all.filter(violation => violation.severity !== 'LOW');
  const severityBlocks = violations.some(violation =>
    violation.severity === 'MEDIUM' || violation.severity === 'HIGH' || violation.severity === 'CRITICAL');
  const lowBlocks = options.strictLowSeverity === true && warnings.length > 0;
  const pass = parsedPass === true && !severityBlocks && !lowBlocks;
  const scored = scoresFor(all);
  return {
    pass,
    status: pass ? 'PASS' : 'FAIL',
    violations,
    warnings,
    attempts: options.attempts,
    modelRole: SEMANTIC_VALIDATOR_MODEL_ROLE,
    ...scored,
    semanticChecks: semanticChecksFor(all)
  };
}

export function qaUnavailableResult(attempts: number, reason = 'Semantic story QA is unavailable.'): StoryValidationResult {
  const violation = makeStoryViolation({
    type: 'QA_UNAVAILABLE',
    severity: 'CRITICAL',
    message: reason,
    suggestedRepair: 'Retry quality validation when the semantic validator is available.'
  });
  return {
    pass: false,
    status: 'QA_UNAVAILABLE',
    violations: [violation],
    warnings: [],
    attempts,
    modelRole: SEMANTIC_VALIDATOR_MODEL_ROLE,
    continuityScore: 0,
    pacingScore: 0,
    semanticChecks: {
      characterGating: false,
      worldFactContinuity: false,
      spoilerContainment: false,
      pacingIntegrity: false,
      characterTraitConsistency: false
    }
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Semantic QA timed out.')), timeoutMs);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

export function buildSemanticValidatorSystemPrompt(): string {
  return `You are the Story Engine V3 semantic-validator. Audit every generated chapter and the batch as a whole against the supplied Validator Views.

Evaluate these distinct failure classes:
- PREMATURE_EVIDENCE: prose directly exposes evidence forbidden at this chapter.
- PREMATURE_INFERENCE / READER_KNOWLEDGE_OVEREXPOSURE: prose enables conclusions above the active inference or reader ceiling.
- MYSTERY_STAGE_VIOLATION / PREMATURE_MYSTERY_RESOLUTION: mystery knowledge or resolution advances beyond the active stage.
- CHRONOLOGY_CONTRADICTION: relative time, elapsed duration, ordering, or event/injury age conflicts with supplied context. Do not flag when context is insufficient.
- LOCATION_CANON_CONTRADICTION: a place's identity or transition conflicts with canon/state.
- CHARACTER_SKILL_DRIFT / COMBAT_POWER_VIOLATION: demonstrated capability conflicts with the canonical profile, restrictions, or human/world limits.
- OPPONENT_COMPETENCE_FAILURE: victory is implausibly cheap given numbers, weapons, training, terrain, surprise, tactics, adaptation, injuries, and cost.
- KNOWLEDGE_LEAK: a character asserts a hidden fact without a source in known facts, plan, POV, or prior events.
- REAL_WORLD_CONTAMINATION / ANACHRONISM: real-world imports or concepts conflict with this fictional world's culture, technology, terminology, or voice. Do not blanket-ban generic historical vocabulary.
- CLICHE_OVERUSE / ORIGINALITY_VIOLATION: semantic equivalents violate supplied originality/style rules; do not police isolated ordinary phrases.
- PLAN_VIOLATION: the prose omits the primary goal or invents an unapproved major goal, character, reveal, or escalation. Semantic adherence does not require literal copying.

Return ONLY strict JSON, with no markdown and no private reasoning:
{"pass":true,"violations":[{"type":"PLAN_VIOLATION","severity":"HIGH","chapterNumber":1,"message":"concise issue","evidence":"short excerpt from generated prose","relatedRuleId":"optional","relatedCharacter":"optional","relatedThreadId":"optional","suggestedRepair":"safe concise repair direction"}]}

Use only supported violation types. Severity policy: CRITICAL/HIGH/MEDIUM block; LOW is advisory. If any blocking issue exists, pass must be false. Evidence must be brief and drawn from generated prose; never output chain-of-thought.`;
}

export async function runSemanticValidation(
  prompt: string,
  runner: SemanticRunner | undefined,
  options: {
    maxAttempts?: number;
    timeoutMs?: number;
    strictLowSeverity?: boolean;
  } = {}
): Promise<StoryValidationResult> {
  const maxAttempts = Math.max(1, Math.min(options.maxAttempts ?? MAX_SEMANTIC_ATTEMPTS, MAX_SEMANTIC_ATTEMPTS));
  if (!runner) return qaUnavailableResult(0, 'Semantic story QA model is unavailable.');
  const timeoutMs = options.timeoutMs ?? DEFAULT_SEMANTIC_TIMEOUT_MS;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const raw = await withTimeout(runner(prompt, buildSemanticValidatorSystemPrompt()), timeoutMs);
      const parsed = parseSemanticValidationResponse(raw);
      return canonicalizeStoryValidation(parsed.pass, parsed.violations, parsed.warnings, {
        strictLowSeverity: options.strictLowSeverity,
        attempts: attempt
      });
    } catch {
      if (attempt === maxAttempts) {
        return qaUnavailableResult(attempt, 'Semantic story QA could not return a valid result after bounded retry.');
      }
    }
  }
  return qaUnavailableResult(maxAttempts);
}
