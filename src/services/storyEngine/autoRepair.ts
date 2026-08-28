import { CreativeChapter } from '../../types';
import { BatchPlan, StoryControl, StoryViolation, StoryViolationType } from './types';
import { validateWriterOutput } from './writer';

export interface SafeRepairViolation {
  type: StoryViolationType;
  severity: StoryViolation['severity'];
  chapterNumber?: number;
  issue: string;
  evidence?: string;
  instruction: string;
}

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

function hiddenStrings(control: StoryControl): Set<string> {
  const secrets = collectSecretStrings(control.authorOnlySecrets || []);
  for (const rawThread of control.mysteryThreads || []) {
    if (rawThread && typeof rawThread === 'object' && !Array.isArray(rawThread)) {
      collectSecretStrings((rawThread as Record<string, unknown>).actualTruth, secrets);
    }
  }
  for (const fact of control.worldFacts || []) {
    if (fact.visibility === 'author_only' || fact.scope === 'hidden_truth') {
      collectSecretStrings(fact.fact, secrets);
      collectSecretStrings(fact.secretTruth, secrets);
    }
  }
  return secrets;
}

function redact(text: string | undefined, secrets: Set<string>): string | undefined {
  if (!text) return undefined;
  let safe = text;
  for (const secret of secrets) safe = safe.split(secret).join('[HIDDEN_DETAIL]');
  return safe;
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
  }
};

export function buildSafeRepairRequest(violations: StoryViolation[], control: StoryControl): SafeRepairViolation[] {
  const secrets = hiddenStrings(control);
  return violations.map(violation => {
    const generic = genericSensitiveRepairs[violation.type];
    return {
      type: violation.type,
      severity: violation.severity,
      chapterNumber: violation.chapterNumber ?? violation.chapter,
      issue: generic?.issue || redact(violation.message || violation.reason, secrets) || 'The chapter failed story QA.',
      evidence: generic ? undefined : redact(violation.evidence || violation.quoteOrDescription, secrets),
      instruction: generic?.instruction
        || redact(violation.suggestedRepair || violation.repairInstruction, secrets)
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
  const safeRequest = buildSafeRepairRequest(violations, control);
  return `${writerContext}

[SAFE REPAIR REQUEST — FIX EVERY ITEM]
${JSON.stringify(safeRequest, null, 2)}

[REJECTED CHAPTER PROSE]
${rejectedChapters.map(chapter => `=== ${chapter.title} ===\n${chapter.content}`).join('\n\n')}

Rewrite the complete chapter. Preserve approved events and output only the required CHAPTER envelope.`;
}

export async function repairBatchOutput(
  rejectedChapters: CreativeChapter[],
  _rawText: string,
  violations: StoryViolation[],
  batchPlan: BatchPlan,
  writerContext: string,
  control: StoryControl,
  runner: (prompt: string, systemInstruction: string) => Promise<string>
): Promise<{ chapters: CreativeChapter[]; rawOutput: string }> {
  const requested = batchPlan.chapters.map(chapter => chapter.chapterNumber);
  const systemInstruction = `You are the Story Engine V3 repair writer.
Rewrite exactly chapters [${requested.join(', ')}] using only the Writer View and safe repair request.
Do not infer or invent hidden facts. Fix every listed issue while preserving approved plan events.
Return only: <CHAPTER number="X" title="Chương X: Tiêu đề">complete prose</CHAPTER>`;
  const prompt = buildRepairPrompt(rejectedChapters, violations, writerContext, control);
  const rawOutput = await runner(prompt, systemInstruction);
  const parsed = validateWriterOutput(rawOutput, requested);
  return { chapters: parsed.chapters, rawOutput };
}
