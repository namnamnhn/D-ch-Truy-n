import { Character, CreativeChapter } from '../../types';
import { BatchPlan } from './types';

export const MAX_WRITER_ATTEMPTS = 3;

export class WriterOutputValidationError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`Writer output không đúng contract: ${violations.join('; ')}`);
    this.name = 'WriterOutputValidationError';
    this.violations = violations;
  }
}

interface ParsedWriterOutput {
  chapters: CreativeChapter[];
  newCharacters: Character[];
  storySummary?: string;
  envelopeCount: number;
  hasMalformedControlContent: boolean;
}

function extractChapterNumber(title: string, explicit?: string): number | null {
  const explicitNumber = explicit ? Number(explicit) : NaN;
  if (Number.isInteger(explicitNumber) && explicitNumber > 0) return explicitNumber;
  const match = title.match(/(?:Chương|Chapter)\s*(\d+)/i);
  if (!match) return null;
  const number = Number(match[1]);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseNewCharacters(rawText: string): Character[] {
  const characters: Character[] = [];
  const regex = /<NEW_CHARACTER\s+name="([^"]+)"(?:\s+gender="([^"]*)")?(?:\s+age="([^"]*)")?(?:\s+role="([^"]*)")?(?:\s+appearance="([^"]*)")?(?:\s+personality="([^"]*)")?\s*\/?>/gi;
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = regex.exec(rawText)) !== null) {
    const name = match[1]?.trim();
    if (!name) continue;
    index++;
    characters.push({
      id: `generated_character_${index}_${name.toLocaleLowerCase('vi-VN').replace(/\W+/g, '_')}`,
      name,
      gender: match[2]?.trim() || 'Chưa rõ',
      age: match[3]?.trim() || 'Chưa rõ',
      role: match[4]?.trim() || 'Nhân vật phụ',
      appearance: match[5]?.trim() || '',
      personality: match[6]?.trim() || ''
    });
  }
  return characters;
}

function parseXmlOutput(rawText: string): ParsedWriterOutput {
  const chapters: CreativeChapter[] = [];
  const summaryMatch = /<STORY_SUMMARY>([\s\S]*?)<\/STORY_SUMMARY>/i.exec(rawText);
  const storySummary = summaryMatch?.[1]?.trim() || undefined;
  const chapterRegex = /<CHAPTER(?:(?:\s+number="(\d+)")|(?:\s+title="([^"]*)")){0,2}(?:(?:\s+number="(\d+)")|(?:\s+title="([^"]*)")){0,2}\s*>([\s\S]*?)<\/CHAPTER>/gi;
  let match: RegExpExecArray | null;
  let envelopeCount = 0;
  let malformed = false;
  while ((match = chapterRegex.exec(rawText)) !== null) {
    envelopeCount++;
    const explicit = match[1] || match[3];
    const title = (match[2] || match[4] || '').trim();
    const chapterNumber = extractChapterNumber(title, explicit);
    const titleNumber = extractChapterNumber(title);
    if (explicit && titleNumber !== null && Number(explicit) !== titleNumber) malformed = true;
    let content = match[5] || '';
    content = content
      .replace(/<NEW_CHARACTER[\s\S]*?\/>/gi, '')
      .replace(/<NEW_CHARACTER[\s\S]*?<\/NEW_CHARACTER>/gi, '')
      .replace(/<STORY_SUMMARY[\s\S]*?<\/STORY_SUMMARY>/gi, '')
      .trim();
    if (/<\/?(?:CHAPTER|STORY_SUMMARY|NEW_CHARACTER|SYSTEM|CONTROL|METADATA)\b/i.test(content)) malformed = true;
    chapters.push({
      id: `chapter_${chapterNumber ?? envelopeCount}_${envelopeCount}`,
      chapterNumber: chapterNumber ?? undefined,
      title: title || (chapterNumber ? `Chương ${chapterNumber}` : ''),
      content,
      status: 'completed'
    });
  }
  const outside = rawText
    .replace(/<CHAPTER\b[\s\S]*?<\/CHAPTER>/gi, '')
    .replace(/<NEW_CHARACTER\b[\s\S]*?\/>/gi, '')
    .replace(/<NEW_CHARACTER\b[\s\S]*?<\/NEW_CHARACTER>/gi, '')
    .replace(/<STORY_SUMMARY>[\s\S]*?<\/STORY_SUMMARY>/gi, '')
    .trim();
  if (outside) malformed = true;
  return {
    chapters,
    newCharacters: parseNewCharacters(rawText),
    storySummary,
    envelopeCount,
    hasMalformedControlContent: malformed
  };
}

function parseLegacyPlainText(rawText: string): ParsedWriterOutput {
  const chapters: CreativeChapter[] = [];
  const parts = rawText.trim().split(/(?=^(?:###?\s*)?(?:Chương|Chapter)\s+\d+)/gmi);
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const titleMatch = /^(?:###?\s*)?((?:Chương|Chapter)\s+\d+[^\n]*)/i.exec(trimmed);
    if (!titleMatch) continue;
    const title = titleMatch[1].trim();
    const chapterNumber = extractChapterNumber(title);
    const content = trimmed.slice(titleMatch[0].length).trim();
    chapters.push({
      id: `chapter_${chapterNumber ?? chapters.length + 1}_${chapters.length + 1}`,
      chapterNumber: chapterNumber ?? undefined,
      title,
      content,
      status: 'completed'
    });
  }
  return {
    chapters,
    newCharacters: [],
    envelopeCount: 0,
    hasMalformedControlContent: false
  };
}

export function parseChaptersAndMetadata(rawText: string): {
  chapters: CreativeChapter[];
  newCharacters: Character[];
  storySummary?: string;
} {
  const xml = parseXmlOutput(rawText);
  const parsed = xml.envelopeCount > 0 ? xml : parseLegacyPlainText(rawText);
  return { chapters: parsed.chapters.filter(chapter => chapter.content), newCharacters: parsed.newCharacters, storySummary: parsed.storySummary };
}

export function validateWriterOutput(rawText: string, requestedChapterNumbers: number[]): {
  chapters: CreativeChapter[];
  newCharacters: Character[];
  storySummary?: string;
} {
  const parsed = parseXmlOutput(rawText);
  const violations: string[] = [];
  if (parsed.envelopeCount === 0) violations.push('Thiếu hoặc sai malformed <CHAPTER> envelope XML.');
  if (parsed.hasMalformedControlContent) violations.push('Có text/control/metadata ngoài envelope cho phép hoặc metadata leak trong prose.');
  const numbers = parsed.chapters.map(chapter => chapter.chapterNumber);
  if (numbers.some(number => number === undefined)) violations.push('Mỗi chapter envelope phải khai báo number hoặc title chứa đúng số chương.');
  const concreteNumbers = numbers.filter((number): number is number => number !== undefined);
  if (new Set(concreteNumbers).size !== concreteNumbers.length) violations.push('Có chapter number trùng lặp.');
  const requested = new Set(requestedChapterNumbers);
  const actual = new Set(concreteNumbers);
  if (concreteNumbers.length !== requestedChapterNumbers.length
    || requestedChapterNumbers.some(number => !actual.has(number))
    || concreteNumbers.some(number => !requested.has(number))) {
    violations.push(`Phải trả đúng [${requestedChapterNumbers.join(', ')}], nhận [${concreteNumbers.join(', ')}].`);
  }
  for (const chapter of parsed.chapters) {
    if (!chapter.content.trim()) violations.push(`Chương ${chapter.chapterNumber ?? '?'} có nội dung rỗng.`);
    if (!chapter.title.trim()) violations.push(`Chương ${chapter.chapterNumber ?? '?'} thiếu title.`);
  }
  if (violations.length) throw new WriterOutputValidationError(violations);
  return { chapters: parsed.chapters, newCharacters: parsed.newCharacters, storySummary: parsed.storySummary };
}

export async function generateChaptersProse(
  writerContext: string,
  batchPlan: BatchPlan,
  runner: (prompt: string, sys: string) => Promise<string>
): Promise<{
  rawOutput: string;
  chapters: CreativeChapter[];
  newCharacters: Character[];
  storySummary?: string;
}> {
  const requested = batchPlan.chapters.map(chapter => chapter.chapterNumber);
  let violations: string[] = [];
  for (let attempt = 1; attempt <= MAX_WRITER_ATTEMPTS; attempt++) {
    const sys = `Bạn là Writer của Story Engine V3. Viết chính xác các chương [${requested.join(', ')}], mỗi chương đúng một lần.
Output chỉ gồm envelope XML theo mẫu:
<CHAPTER number="X" title="Chương X: Tiêu đề">Nội dung văn xuôi không rỗng</CHAPTER>
Sau các chapter có thể có NEW_CHARACTER tự đóng và một STORY_SUMMARY. Không có control block hay prose ngoài envelope.${violations.length
  ? `\nOutput trước bị reject. Hãy sửa các lỗi cấu trúc sau:\n${violations.join('\n')}` : ''}`;
    const prompt = `${writerContext}\n\nViết đúng output contract cho [${requested.join(', ')}].`;
    const rawOutput = await runner(prompt, sys);
    try {
      const parsed = validateWriterOutput(rawOutput, requested);
      return { rawOutput, ...parsed };
    } catch (error) {
      violations = error instanceof WriterOutputValidationError ? error.violations : [String(error)];
      if (attempt === MAX_WRITER_ATTEMPTS) throw new WriterOutputValidationError(violations);
    }
  }
  throw new WriterOutputValidationError(violations.length ? violations : ['Không có output.']);
}
