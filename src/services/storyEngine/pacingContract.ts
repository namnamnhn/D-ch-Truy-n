import { JsonObject, PacingRules, StoryControl } from './types';

export interface ChapterPacingTarget {
  min: number;
  ideal: number;
  max: number;
  soft: boolean;
  neverPadWithFiller: boolean;
}

const DEFAULT_MIN = 2000;
const DEFAULT_MAX = 3500;

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * Normalizes the author-facing chapterWordTarget settings into the single
 * authoritative pacing shape stored on StoryControl.
 *
 * soft=true makes only the minimum advisory. The ideal remains the drafting
 * target and the maximum remains a hard structural ceiling.
 */
export function normalizeChapterWordTarget(
  settings?: JsonObject,
  existing?: Partial<PacingRules>
): ChapterPacingTarget {
  const configured = record(settings?.chapterWordTarget);
  const min = positiveNumber(configured?.min)
    ?? positiveNumber(existing?.minWordsPerChapter)
    ?? DEFAULT_MIN;
  const maxCandidate = positiveNumber(configured?.max)
    ?? positiveNumber(existing?.maxWordsPerChapter)
    ?? DEFAULT_MAX;
  const max = Math.max(min, maxCandidate);
  const defaultIdeal = Math.round((min + max) / 2);
  const idealCandidate = positiveNumber(configured?.ideal)
    ?? positiveNumber(existing?.idealWordsPerChapter)
    ?? defaultIdeal;
  const ideal = Math.min(max, Math.max(min, idealCandidate));
  const soft = typeof configured?.soft === 'boolean'
    ? configured.soft
    : typeof existing?.softMinimumWords === 'boolean'
      ? existing.softMinimumWords
      : settings?.softMinimumWords === true;
  const neverPadWithFiller = typeof configured?.neverPadWithFiller === 'boolean'
    ? configured.neverPadWithFiller
    : existing?.neverPadWithFiller === true || settings?.neverPadWithFiller === true;
  return { min, ideal, max, soft, neverPadWithFiller };
}

export function pacingRulesFromSettings(
  settings?: JsonObject,
  existing?: Partial<PacingRules>
): PacingRules {
  const target = normalizeChapterWordTarget(settings, existing);
  return {
    minWordsPerChapter: target.min,
    idealWordsPerChapter: target.ideal,
    maxWordsPerChapter: target.max,
    softMinimumWords: target.soft,
    neverPadWithFiller: target.neverPadWithFiller,
    climaxPacingMultiplier: positiveNumber(existing?.climaxPacingMultiplier) ?? 1.3,
    cooldownChaptersAfterClimax: positiveNumber(existing?.cooldownChaptersAfterClimax) ?? 2
  };
}

export function getChapterPacingTarget(control: StoryControl): ChapterPacingTarget {
  return normalizeChapterWordTarget(control.settings, control.pacingRules);
}

export function normalizeStoryControlPacing(control: StoryControl): StoryControl {
  return { ...control, pacingRules: pacingRulesFromSettings(control.settings, control.pacingRules) };
}

export function formatChapterPacingTarget(target: ChapterPacingTarget): string {
  return `min=${target.min} ideal=${target.ideal} max=${target.max} soft=${target.soft} neverPadWithFiller=${target.neverPadWithFiller}`;
}
