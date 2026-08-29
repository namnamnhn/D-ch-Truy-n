import { CreativeChapter } from '../../types';
import { BatchPlan, StoryBible, StoryControl, StoryViolation, StoryViolationType } from './types';
import { validateWriterOutput } from './writer';
import { collectHiddenStoryStrings, redactHiddenStoryText } from './diagnostics';
import { createWriterOutputLanguageContract } from './languageContract';
import { formatChapterPacingTarget, getChapterPacingTarget } from './pacingContract';

export interface SafeRepairViolation {
  type: StoryViolationType;
  severity: StoryViolation['severity'];
  chapterNumber?: number;
  issue: string;
  evidence?: string;
  instruction: string;
}

const genericSensitiveRepairs: Partial<Record<StoryViolationType, { issue: string; instruction: string }>> = {
  PREMATURE_EVIDENCE: {
    issue: 'The passage exposes evidence beyond what this chapter permits.',
    instruction: 'Remove the premature evidence and retain only the uncertainty and evidence allowed by the Writer View.'
  },
  PREMATURE_INFERENCE: {
    issue: 'The passage draws a conclusion beyond the permitted inference level.',
    instruction: 'Keep the conclusion at the current level of suspicion; do not identify the hidden cause, actor, or mechanism.'
  },
  READER_KNOWLEDGE_OVEREXPOSURE: {
    issue: 'Reader knowledge rises above the ceiling for this chapter.',
    instruction: 'Rewrite from the current POV using only knowledge already available in the Writer View.'
  },
  MYSTERY_STAGE_VIOLATION: {
    issue: 'The mystery advances beyond its permitted stage.',
    instruction: 'Return the mystery to the approved stage and preserve ambiguity.'
  },
  PREMATURE_MYSTERY_RESOLUTION: {
    issue: 'The passage resolves identity, cause, or mechanism too early.',
    instruction: 'Replace certainty with an unresolved suspicion; do not name or describe the hidden answer.'
  },
  WORLD_FACT_GATE_VIOLATION: {
    issue: 'The passage relies on world knowledge that is not available yet.',
    instruction: 'Use only world facts present in the Writer View and avoid describing the locked fact.'
  },
  SPOILER_LEAK: {
    issue: 'The passage reveals gated story information.',
    instruction: 'Remove the reveal and preserve uncertainty without restating the hidden information.'
  },
  KNOWLEDGE_LEAK: {
    issue: 'A character knows something without an established source.',
    instruction: 'Remove the unsupported certainty or add a plan-consistent, reader-visible source already available in the Writer View.'
  },
  FACT_CONTRADICTION: {
    issue: 'A concrete fact conflicts with earlier accepted prose.',
    instruction: 'Preserve the established fact in the in-batch continuity lock. Modify only the conflicting later prose unless the approved plan explicitly requires a change event.'
  },
  REPEATED_DISCOVERY: {
    issue: 'A completed discovery is presented again as first-time information.',
    instruction: 'Acknowledge prior knowledge. Convert the repeated first-discovery scene into plan-approved continuation, explicit re-verification, or a new consequence without repeating the reveal.'
  },
  REAL_WORLD_CONTAMINATION: {
    issue: 'The prose contains language or world contamination outside the configured allowance.',
    instruction: 'Replace only the contaminating fragment with natural target-language, world-native prose without changing any story fact.'
  },
  WORD_COUNT_DEFICIT: {
    issue: 'The chapter is below the configured structural minimum length.',
    instruction: 'Expand the existing approved plan through action, sensory detail, dialogue, reasoning, character interaction, tactical friction, environment, and consequences. Do not add filler, duplicate exposition, a new major plot event, a mystery dump, a new major character, or a forced cliffhanger.'
  },
  WORD_COUNT_EXCESS: {
    issue: 'The chapter exceeds the configured hard maximum length.',
    instruction: 'Tighten the approved scenes without removing required events, continuity facts, or necessary consequences.'
  }
};

export function buildSafeRepairRequest(violations: StoryViolation[], control: StoryControl): SafeRepairViolation[] {
  const chapters = violations.map(violation => violation.chapterNumber ?? violation.chapter).filter((chapter): chapter is number =>
    typeof chapter === 'number' && Number.isInteger(chapter) && chapter > 0);
  const secrets = collectHiddenStoryStrings(control, chapters);
  return violations.map(violation => {
    const generic = genericSensitiveRepairs[violation.type];
    return {
      type: violation.type,
      severity: violation.severity,
      chapterNumber: violation.chapterNumber ?? violation.chapter,
      issue: generic?.issue || redactHiddenStoryText(violation.message || violation.reason, secrets) || 'The chapter failed story QA.',
      evidence: generic ? undefined : redactHiddenStoryText(violation.evidence || violation.quoteOrDescription, secrets),
      instruction: generic?.instruction
        || redactHiddenStoryText(violation.suggestedRepair || violation.repairInstruction, secrets)
        || 'Rewrite the affected passage to follow the approved plan and Writer View.'
    };
  });
}

export function buildRepairPrompt(
  rejectedChapters: CreativeChapter[],
  violations: StoryViolation[],
  writerContext: string,
  control: StoryControl
): string {
  const chapters = rejectedChapters.map(chapter => chapter.chapterNumber).filter((chapter): chapter is number =>
    typeof chapter === 'number' && Number.isInteger(chapter) && chapter > 0);
  const secrets = collectHiddenStoryStrings(control, chapters);
  const safeRequest = buildSafeRepairRequest(violations, control);
  const prompt = `${writerContext}

[SAFE REPAIR REQUEST — FIX EVERY ITEM]
${JSON.stringify(safeRequest, null, 2)}

[REJECTED CHAPTER PROSE]
${rejectedChapters.map(chapter => `=== ${chapter.title} ===\n${chapter.content}`).join('\n\n')}

Rewrite the complete chapter. Preserve approved events and output only the required CHAPTER envelope.`;
  return redactHiddenStoryText(prompt, secrets) || '';
}

export async function repairBatchOutput(
  rejectedChapters: CreativeChapter[],
  _rawText: string,
  violations: StoryViolation[],
  batchPlan: BatchPlan,
  writerContext: string,
  control: StoryControl,
  runner: (prompt: string, systemInstruction: string) => Promise<string>,
  bible?: StoryBible
): Promise<{ chapters: CreativeChapter[]; rawOutput: string }> {
  const requested = batchPlan.chapters.map(chapter => chapter.chapterNumber);
  const pacingTarget = getChapterPacingTarget(control);
  const systemInstruction = `You are the Story Engine V3 repair writer.
Rewrite exactly chapters [${requested.join(', ')}] using only the Writer View and safe repair request.
Do not infer or invent hidden facts. Fix every listed issue while preserving approved plan events.
Chapter pacing contract: ${formatChapterPacingTarget(pacingTarget)}. The maximum is hard; the minimum is ${pacingTarget.soft ? 'advisory' : 'hard'}. ${pacingTarget.neverPadWithFiller ? 'Never pad with filler to reach a word target.' : ''}
Return only: <CHAPTER number="X" title="Chương X: Tiêu đề">complete prose</CHAPTER>`;
  const prompt = buildRepairPrompt(rejectedChapters, violations, writerContext, control);
  const rawOutput = await runner(prompt, systemInstruction);
  const parsed = validateWriterOutput(rawOutput, requested, {
    minimumWords: pacingTarget.min,
    idealWords: pacingTarget.ideal,
    maximumWords: pacingTarget.max,
    softMinimumWords: pacingTarget.soft,
    neverPadWithFiller: pacingTarget.neverPadWithFiller,
    outputLanguage: createWriterOutputLanguageContract(control, bible, Math.min(...requested))
  });
  return { chapters: parsed.chapters, rawOutput };
}
