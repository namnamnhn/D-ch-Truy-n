import { CreativeChapter } from '../../types';
import {
  ChapterPlan,
  InBatchContinuityLock,
  InBatchEstablishedFact
} from './types';

const NUMBER_WORDS: Record<string, string> = {
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
  'không': '0', 'một': '1', 'hai': '2', 'ba': '3', 'bốn': '4', 'tư': '4', 'năm': '5', 'sáu': '6', 'bảy': '7', 'tám': '8', 'chín': '9', 'mười': '10'
};

const MEASUREMENT_UNITS = 'units?|pieces?|coins?|grams?|kilograms?|meters?|centimeters?|liters?|pounds?|ounces?|liang|taels?|lạng|lượng|cân|chỉ|đồng|xu|thước|tấc|trượng|dặm';
const VALUE_PATTERN = `[0-9]+(?:[.,][0-9]+)?|${Object.keys(NUMBER_WORDS).join('|')}`;

export function createEmptyInBatchContinuityLock(): InBatchContinuityLock {
  return {
    establishedFacts: [], completedDiscoveries: [], knownByCharacter: [],
    objectFacts: [], locationFacts: [], timeFacts: []
  };
}

function normalizedId(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '');
}

function normalizedValue(value: string): string {
  const folded = value.trim().toLocaleLowerCase('vi-VN');
  return NUMBER_WORDS[folded] || folded.replace(',', '.');
}

function cleanSubject(value: string): string {
  return value.trim().replace(/^(?:the|a|an|một)\s+/iu, '').replace(/\s+/g, ' ');
}

function fact(subject: string, predicate: string, value: string, unit: string | undefined, chapter: number, evidence: string): InBatchEstablishedFact {
  const clean = cleanSubject(subject);
  const normalizedUnit = unit?.trim().toLocaleLowerCase('vi-VN');
  return {
    id: `${normalizedId(clean)}.${normalizedId(predicate)}`,
    subject: clean,
    predicate,
    value: normalizedValue(value),
    unit: normalizedUnit,
    establishedChapter: chapter,
    established: true,
    evidence: evidence.trim().slice(0, 240)
  };
}

export function extractConcreteFacts(content: string, chapter: number): InBatchEstablishedFact[] {
  const facts: InBatchEstablishedFact[] = [];
  const explicit = new RegExp(`(?:object|subject)\\s*=\\s*([\\p{L}\\p{N}_-]+)[^\\n.]{0,100}?(weight|quantity|amount|count|value)\\s*=\\s*(${VALUE_PATTERN})\\s*([\\p{L}\\p{M}%°_-]+)`, 'giu');
  for (const match of content.matchAll(explicit)) facts.push(fact(match[1], match[2].toLocaleLowerCase('en-US'), match[3], match[4], chapter, match[0]));

  const verbal = new RegExp(`((?:[\\p{L}\\p{M}_-]+\\s+){0,3}[\\p{L}\\p{M}_-]+)\\s+(weighs?|weighed|weight(?:\\s+is)?|contains?|contained|measures?|measured|nặng|có\\s+trọng\\s+lượng|trọng\\s+lượng(?:\\s+là)?|số\\s+lượng(?:\\s+là)?)\\s+(${VALUE_PATTERN})\\s+(${MEASUREMENT_UNITS})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  for (const match of content.matchAll(verbal)) facts.push(fact(match[1], 'quantity', match[3], match[4], chapter, match[0]));

  const compact = new RegExp(`((?:[\\p{L}\\p{M}_-]+\\s+){0,1}[\\p{L}\\p{M}_-]+)\\s+(${VALUE_PATTERN})\\s+(${MEASUREMENT_UNITS})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  for (const match of content.matchAll(compact)) facts.push(fact(match[1], 'quantity', match[2], match[3], chapter, match[0]));

  return Array.from(new Map(facts.filter(item => item.subject.length >= 2).map(item => [item.id, item])).values());
}

function includesExplicitChangeEvent(content: string): boolean {
  return /(?:^|[^\p{L}])(?:changed|replaced|exchanged|added|removed|became|increased|decreased|đổi|thay|thêm|bớt|tăng|giảm|tráo)(?=$|[^\p{L}])/iu.test(content);
}

function localFactContext(content: string, evidence: string): string {
  const index = content.indexOf(evidence);
  if (index < 0) return evidence;
  const sentenceStart = Math.max(content.lastIndexOf('.', index - 1), content.lastIndexOf('\n', index - 1));
  const sentenceEndCandidate = content.indexOf('.', index + evidence.length);
  const sentenceEnd = sentenceEndCandidate < 0 ? content.length : sentenceEndCandidate + 1;
  return content.slice(sentenceStart + 1, sentenceEnd);
}

export function findConcreteFactContradictions(
  lock: InBatchContinuityLock,
  chapter: CreativeChapter
): Array<{ established: InBatchEstablishedFact; conflicting: InBatchEstablishedFact }> {
  const current = extractConcreteFacts(chapter.content || '', chapter.chapterNumber || 0);
  const contradictions: Array<{ established: InBatchEstablishedFact; conflicting: InBatchEstablishedFact }> = [];
  for (const candidate of current) {
    const established = lock.establishedFacts.find(item => item.id === candidate.id);
    if (established
      && (established.value !== candidate.value || established.unit !== candidate.unit)
      && !includesExplicitChangeEvent(localFactContext(chapter.content || '', candidate.evidence))) {
      contradictions.push({ established, conflicting: candidate });
    }
  }
  return contradictions;
}

export function extendInBatchContinuityLock(
  lock: InBatchContinuityLock,
  chapter: CreativeChapter,
  plan: ChapterPlan
): InBatchContinuityLock {
  const next: InBatchContinuityLock = JSON.parse(JSON.stringify(lock));
  for (const item of extractConcreteFacts(chapter.content || '', chapter.chapterNumber || plan.chapterNumber)) {
    if (!next.establishedFacts.some(existing => existing.id === item.id)) {
      next.establishedFacts.push(item);
      next.objectFacts.push(item);
    }
  }
  for (const description of plan.cluesDiscovered || []) {
    const id = normalizedId(description);
    if (!id || next.completedDiscoveries.some(item => item.id === id)) continue;
    next.completedDiscoveries.push({
      id,
      description,
      completedChapter: chapter.chapterNumber || plan.chapterNumber,
      discoveredBy: plan.povCharacter || undefined,
      acknowledgedAsPrior: true
    });
    if (plan.povCharacter) next.knownByCharacter.push({
      character: plan.povCharacter,
      fact: description,
      learnedChapter: chapter.chapterNumber || plan.chapterNumber
    });
  }
  return next;
}

export function formatInBatchContinuityLock(lock: InBatchContinuityLock): string {
  return `[IN-BATCH CONTINUITY LOCK — EPHEMERAL, IMMUTABLE FOR LATER CHAPTERS]\nPrevious structurally accepted in-batch prose establishes the machine-readable facts below:\n${JSON.stringify(lock, null, 2)}\nTreat these prior facts and discoveries as immutable established continuity. Do not change concrete quantities, object identity, injury state without an event, knowledge ownership, location, or relative time. Do not present a completed discovery or revelation as first-time information again. Re-verification, doubt, or independent learning is allowed only when the approved plan explicitly requires it, and the prose must acknowledge the prior discovery.`;
}
