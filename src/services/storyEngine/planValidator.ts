import { BatchPlan, ChapterPlan, StoryControl, StoryState } from './types';
import {
  findCharacter,
  getActiveMysteryStages,
  getArcForChapter,
  getCharacterAccess,
  getWorldFactGateChapter,
  isWorldFactAvailable,
  normalizeReference,
  projectExposureRules
} from './storyAccess';
import { parseJsonObject } from './runtimeValidation';

export type PlanViolationCode =
  | 'PLAN_STRUCTURE'
  | 'CHAPTER_MISMATCH'
  | 'ARC_MISMATCH'
  | 'CHARACTER_LOCKED'
  | 'DIRECT_APPEARANCE_LOCKED'
  | 'POV_LOCKED'
  | 'MAJOR_FOCUS_LOCKED'
  | 'WORLD_FACT_LOCKED'
  | 'WORLD_FACT_AUTHOR_ONLY'
  | 'FORBIDDEN_EVIDENCE'
  | 'FORBIDDEN_INFERENCE'
  | 'FUTURE_ARC_BEAT'
  | 'MYSTERY_STAGE_LOCKED';

export interface PlanViolation {
  code: PlanViolationCode;
  chapter?: number;
  field?: string;
  reference?: string;
  message: string;
}

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  violations: PlanViolation[];
  repairedPlan: BatchPlan;
}

export interface SemanticPlanValidationResult {
  valid: boolean;
  error?: string;
}

export async function validateBatchPlanSemantically(
  plan: BatchPlan,
  control: StoryControl,
  state: StoryState,
  runner: (prompt: string, systemInstruction: string) => Promise<string>
): Promise<SemanticPlanValidationResult> {
  const systemInstruction = `You are the Story Engine V3 semantic plan validator.
Audit the approved ChapterPlan against the complete hidden StoryControl and StoryState.
Reject contradictions, premature reveals/inferences, implausible continuity, character capability drift,
future-arc leakage, or a plan that cannot satisfy the active mystery/exposure stage.
Return only strict JSON: {"pass":true,"violations":[]}.
violations must contain only short category labels, never hidden facts, answers, evidence, or explanations.`;
  const prompt = `=== STORY ENGINE V3: INTERNAL PLAN VALIDATOR INPUT ===\n${JSON.stringify({ plan, control, state }, null, 2)}`;
  const parsed = parseJsonObject(await runner(prompt, systemInstruction), 'Semantic Plan Validator output');
  if (typeof parsed.pass !== 'boolean' || !Array.isArray(parsed.violations)
    || parsed.violations.some(value => typeof value !== 'string')) {
    throw new Error('Semantic Plan Validator output must contain boolean pass and string[] violations.');
  }
  if (parsed.pass !== true || parsed.violations.length > 0) {
    return { valid: false, error: 'SEMANTIC_PLAN_REJECTED: revise the plan without exposing hidden validator context.' };
  }
  return { valid: true };
}

function explicitMatch(value: string, forbidden: string): boolean {
  const left = normalizeReference(value);
  const right = normalizeReference(forbidden);
  return Boolean(left && right && (left === right || left.includes(right) || right.includes(left)));
}

function planCharacterReferences(chapter: ChapterPlan): Array<{ field: string; value: string }> {
  return [
    ...(chapter.activeCharacters || []).map(value => ({ field: 'activeCharacters', value })),
    ...(chapter.introducedCharacters || []).map(value => ({ field: 'introducedCharacters', value })),
    ...(chapter.plannedCharacters || []).map(value => ({ field: 'plannedCharacters', value }))
  ];
}

function addViolation(target: PlanViolation[], violation: PlanViolation): void {
  if (!target.some(existing => existing.code === violation.code
    && existing.chapter === violation.chapter
    && existing.field === violation.field
    && existing.reference === violation.reference)) {
    target.push(violation);
  }
}

export function validateBatchPlan(
  plan: BatchPlan,
  control: StoryControl,
  _state: StoryState,
  requestedChapterNumbers: number[] = plan.requestedChapterNumbers
    || Array.from({ length: Math.max(0, plan.endChapter - plan.startChapter + 1) }, (_, index) => plan.startChapter + index)
): PlanValidationResult {
  const repairedPlan: BatchPlan = JSON.parse(JSON.stringify(plan));
  const violations: PlanViolation[] = [];
  const actualNumbers = repairedPlan.chapters.map(chapter => chapter.chapterNumber);
  const requestedSet = new Set(requestedChapterNumbers);
  if (actualNumbers.length !== requestedChapterNumbers.length
    || new Set(actualNumbers).size !== actualNumbers.length
    || actualNumbers.some(number => !requestedSet.has(number))) {
    addViolation(violations, {
      code: 'CHAPTER_MISMATCH',
      message: `Plan phải chứa đúng một ChapterPlan cho [${requestedChapterNumbers.join(', ')}], nhận [${actualNumbers.join(', ')}].`
    });
  }

  for (const chapter of repairedPlan.chapters) {
    if (!Number.isInteger(chapter.chapterNumber) || chapter.chapterNumber < 1) {
      addViolation(violations, { code: 'PLAN_STRUCTURE', message: 'chapterNumber phải là số nguyên dương.' });
      continue;
    }
    const arc = getArcForChapter(control, chapter.chapterNumber);
    if (chapter.arcId && chapter.arcId !== arc.id) {
      addViolation(violations, {
        code: 'ARC_MISMATCH', chapter: chapter.chapterNumber, field: 'arcId', reference: chapter.arcId,
        message: `Chương ${chapter.chapterNumber} thuộc ${arc.id}, không phải ${chapter.arcId}.`
      });
    }
    chapter.arcId = arc.id;

    const retainedCharacters: string[] = [];
    for (const reference of planCharacterReferences(chapter)) {
      const character = findCharacter(control, reference.value);
      if (!character) {
        const gate = (control.characterGates || []).find(candidate =>
          normalizeReference(candidate.characterId) === normalizeReference(reference.value)
          || normalizeReference(candidate.characterName) === normalizeReference(reference.value));
        if (gate && chapter.chapterNumber < gate.unlockAtChapter) {
          addViolation(violations, {
            code: 'CHARACTER_LOCKED', chapter: chapter.chapterNumber, field: reference.field, reference: reference.value,
            message: `${gate.characterName} bị khóa đến Chương ${gate.unlockAtChapter}.`
          });
          continue;
        }
        retainedCharacters.push(reference.value);
        continue;
      }
      const access = getCharacterAccess(control, character, chapter.chapterNumber);
      if (!access.canMention) {
        addViolation(violations, {
          code: 'CHARACTER_LOCKED', chapter: chapter.chapterNumber, field: reference.field, reference: reference.value,
          message: `${character.name} bị khóa đến Chương ${access.unlockChapter}.`
        });
        continue;
      }
      if (!access.canAppearDirectly) {
        addViolation(violations, {
          code: 'DIRECT_APPEARANCE_LOCKED', chapter: chapter.chapterNumber, field: reference.field, reference: reference.value,
          message: `${character.name} chỉ được xuất hiện trực tiếp từ Chương ${access.directAppearanceChapter}.`
        });
        continue;
      }
      retainedCharacters.push(reference.value);
    }
    chapter.activeCharacters = (chapter.activeCharacters || []).filter(reference => retainedCharacters.includes(reference));
    chapter.introducedCharacters = (chapter.introducedCharacters || []).filter(reference => retainedCharacters.includes(reference));
    if (chapter.plannedCharacters) {
      chapter.plannedCharacters = chapter.plannedCharacters.filter(reference => retainedCharacters.includes(reference));
    }

    if (chapter.povCharacter) {
      const pov = findCharacter(control, chapter.povCharacter);
      if (pov) {
        const access = getCharacterAccess(control, pov, chapter.chapterNumber);
        if (!access.canUsePov) {
          addViolation(violations, {
            code: 'POV_LOCKED', chapter: chapter.chapterNumber, field: 'povCharacter', reference: chapter.povCharacter,
            message: `POV ${pov.name} chỉ được phép từ Chương ${access.povUnlockChapter}.`
          });
        }
      }
    }

    if (chapter.majorFocusCharacter) {
      const focus = findCharacter(control, chapter.majorFocusCharacter);
      if (focus) {
        const access = getCharacterAccess(control, focus, chapter.chapterNumber);
        if (!access.canTakeMajorFocus) {
          addViolation(violations, {
            code: 'MAJOR_FOCUS_LOCKED', chapter: chapter.chapterNumber, field: 'majorFocusCharacter', reference: chapter.majorFocusCharacter,
            message: `${focus.name} chỉ được làm trọng tâm lớn từ Chương ${access.majorFocusNotBeforeChapter}.`
          });
        }
      }
    }

    for (const reference of [...(chapter.plannedWorldFacts || []), ...(chapter.worldFactInteractions || [])]) {
      const fact = (control.worldFacts || []).find(candidate =>
        normalizeReference(candidate.id) === normalizeReference(reference)
        || normalizeReference(candidate.fact) === normalizeReference(reference));
      if (!fact) continue;
      if (fact.visibility === 'author_only' || fact.scope === 'hidden_truth') {
        addViolation(violations, {
          code: 'WORLD_FACT_AUTHOR_ONLY', chapter: chapter.chapterNumber, field: 'plannedWorldFacts', reference,
          message: `WorldFact ${fact.id} là author_only và không được dùng trong plan.`
        });
      } else if (!isWorldFactAvailable(fact, chapter.chapterNumber)) {
        addViolation(violations, {
          code: 'WORLD_FACT_LOCKED', chapter: chapter.chapterNumber, field: 'plannedWorldFacts', reference,
          message: `WorldFact ${fact.id} bị khóa đến Chương ${getWorldFactGateChapter(fact)}.`
        });
      }
    }

    const exposure = projectExposureRules(control, chapter.chapterNumber, true);
    for (const evidence of chapter.plannedEvidence || []) {
      const forbidden = exposure.forbiddenEvidence.find(rule => explicitMatch(evidence, rule));
      if (forbidden) addViolation(violations, {
        code: 'FORBIDDEN_EVIDENCE', chapter: chapter.chapterNumber, field: 'plannedEvidence', reference: evidence,
        message: `Evidence "${evidence}" bị cấm bởi exposure rule active.`
      });
    }
    for (const inference of chapter.plannedInferences || []) {
      const forbidden = exposure.forbiddenInferences.find(rule => explicitMatch(inference, rule));
      if (forbidden) addViolation(violations, {
        code: 'FORBIDDEN_INFERENCE', chapter: chapter.chapterNumber, field: 'plannedInferences', reference: inference,
        message: `Inference "${inference}" bị cấm bởi exposure rule active.`
      });
    }

    const otherArcMilestones = control.arcs
      .filter(candidate => candidate.id !== arc.id)
      .flatMap(candidate => candidate.keyMilestones.map(beat => ({ arcId: candidate.id, beat })));
    for (const beat of [...(chapter.arcBeatIds || []), ...(chapter.requiredEvents || [])]) {
      const future = otherArcMilestones.find(candidate => explicitMatch(beat, candidate.beat)
        || normalizeReference(beat).startsWith(`${normalizeReference(candidate.arcId)}:`));
      if (future) addViolation(violations, {
        code: 'FUTURE_ARC_BEAT', chapter: chapter.chapterNumber, field: 'arcBeatIds', reference: beat,
        message: `Beat "${beat}" thuộc ${future.arcId}, ngoài Arc hiện tại ${arc.id}.`
      });
    }

    if (chapter.mysteryStageId) {
      const activeStageIds = new Set(getActiveMysteryStages(control, chapter.chapterNumber).map(item => item.stage.id));
      if (!activeStageIds.has(chapter.mysteryStageId)) {
        addViolation(violations, {
          code: 'MYSTERY_STAGE_LOCKED', chapter: chapter.chapterNumber, field: 'mysteryStageId', reference: chapter.mysteryStageId,
          message: `Mystery stage ${chapter.mysteryStageId} không active tại Chương ${chapter.chapterNumber}.`
        });
      }
    }

    const validPacings: ChapterPlan['pacingTarget'][] = ['slow_build', 'rising_action', 'climax', 'cliffhanger', 'cool_down'];
    if (!validPacings.includes(chapter.pacingTarget)) {
      addViolation(violations, {
        code: 'PLAN_STRUCTURE', chapter: chapter.chapterNumber, field: 'pacingTarget', reference: chapter.pacingTarget,
        message: `pacingTarget không hợp lệ tại Chương ${chapter.chapterNumber}.`
      });
      chapter.pacingTarget = 'rising_action';
    }
  }

  const errors = violations.map(violation => `[${violation.code}] ${violation.message}`);
  repairedPlan.charactersGated = violations
    .filter(violation => violation.code === 'CHARACTER_LOCKED' || violation.code === 'DIRECT_APPEARANCE_LOCKED')
    .map(violation => violation.reference || '')
    .filter(Boolean);
  repairedPlan.planValid = violations.length === 0;
  repairedPlan.planValidationErrors = errors;
  repairedPlan.requestedChapterNumbers = [...requestedChapterNumbers];
  return { valid: violations.length === 0, errors, violations, repairedPlan };
}

export function validateAndRepairBatchPlan(
  plan: BatchPlan,
  control: StoryControl,
  state: StoryState,
  startChapter: number
): PlanValidationResult {
  const requested = plan.requestedChapterNumbers
    || Array.from({ length: Math.max(1, plan.endChapter - startChapter + 1) }, (_, index) => startChapter + index);
  return validateBatchPlan(plan, control, state, requested);
}
