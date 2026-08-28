import { CreativeChapter } from '../../types';

export interface StyleLintResult {
  passed: boolean;
  violations: string[];
  clichéCounts: Record<string, number>;
}

const DEFAULT_FORBIDDEN_TERMS = [
  'xe tăng',
  'vũ khí sinh học',
  'khoa học là sức mạnh',
  'bài kiểm tra đầu vào',
  'nâng cấp tư duy',
  'đèn pha',
  'hệ thống logic'
];

const CLICHE_PATTERNS = [
  { name: 'bàn cờ / quân cờ', regex: /\b(bàn cờ|quân cờ)\b/gi, maxAllowed: 2 },
  { name: 'bánh xe vận mệnh', regex: /\b(bánh xe (của )?vận mệnh)\b/gi, maxAllowed: 1 },
  { name: 'trong bóng tối có đôi mắt', regex: /\b(trong bóng tối.*?(đôi mắt|ánh mắt))\b/gi, maxAllowed: 1 },
  { name: 'thú vị (overused)', regex: /\b(thật thú vị|ngươi rất thú vị|thú vị đấy)\b/gi, maxAllowed: 2 },
];

/**
 * Deterministic Style Linter kiểm tra từ cấm, rò rỉ thẻ metadata và tần suất sáo ngữ.
 */
export function lintChapterProse(
  chapters: CreativeChapter[],
  customForbiddenTerms: string[] = []
): StyleLintResult {
  const violations: string[] = [];
  const clichéCounts: Record<string, number> = {};

  const allForbidden = Array.from(new Set([...DEFAULT_FORBIDDEN_TERMS, ...customForbiddenTerms]));

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const content = ch.content || '';
    const chNum = i + 1;

    // 1. Kiểm tra rò rỉ thẻ metadata trong nội dung chương
    if (/<NEW_CHARACTER/i.test(content)) {
      violations.push(`Chương ${chNum}: Rò rỉ thẻ hệ thống <NEW_CHARACTER> vào nội dung văn xuôi.`);
    }
    if (/<STORY_SUMMARY/i.test(content)) {
      violations.push(`Chương ${chNum}: Rò rỉ thẻ hệ thống <STORY_SUMMARY> vào nội dung văn xuôi.`);
    }
    if (/<\/?CHAPTER/i.test(content)) {
      violations.push(`Chương ${chNum}: Còn sót thẻ đóng/mở <CHAPTER> trong nội dung chương.`);
    }

    // 2. Kiểm tra từ cấm (Forbidden Terms)
    for (const term of allForbidden) {
      if (!term) continue;
      const termRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      if (termRegex.test(content)) {
        violations.push(`Chương ${chNum}: Chứa từ ngữ/khái niệm cấm sử dụng: "${term}".`);
      }
    }

    // 3. Đếm sáo ngữ (Cliché Counter)
    for (const cp of CLICHE_PATTERNS) {
      const matches = content.match(cp.regex);
      const count = matches ? matches.length : 0;
      clichéCounts[cp.name] = (clichéCounts[cp.name] || 0) + count;
      if (count > cp.maxAllowed) {
        violations.push(`Chương ${chNum}: Lạm dụng sáo ngữ "${cp.name}" (${count} lần, mức tối đa khuyến nghị: ${cp.maxAllowed}).`);
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    clichéCounts
  };
}
