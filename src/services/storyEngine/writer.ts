import { Character, CreativeChapter } from '../../types';
import { BatchPlan } from './types';

/**
 * Trích xuất các chương truyện và metadata từ đầu ra của AI.
 * Đảm bảo làm sạch các thẻ metadata khỏi nội dung văn xuôi.
 */
export function parseChaptersAndMetadata(rawText: string): {
  chapters: CreativeChapter[];
  newCharacters: Character[];
  storySummary?: string;
} {
  const chapters: CreativeChapter[] = [];
  const newCharacters: Character[] = [];
  let storySummary: string | undefined;

  // 1. Trích xuất <STORY_SUMMARY>...</STORY_SUMMARY>
  const summaryMatch = /<STORY_SUMMARY>([\s\S]*?)<\/STORY_SUMMARY>/i.exec(rawText);
  if (summaryMatch) {
    storySummary = summaryMatch[1].trim();
  }

  // 2. Trích xuất các nhân vật mới <NEW_CHARACTER name="..." ... />
  const charRegex = /<NEW_CHARACTER\s+name="([^"]+)"(?:\s+gender="([^"]*)")?(?:\s+age="([^"]*)")?(?:\s+role="([^"]*)")?(?:\s+appearance="([^"]*)")?(?:\s+personality="([^"]*)")?\s*\/?>/gi;
  let charMatch;
  while ((charMatch = charRegex.exec(rawText)) !== null) {
    const name = charMatch[1]?.trim();
    if (name) {
      newCharacters.push({
        id: `char_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        name,
        gender: charMatch[2]?.trim() || 'Chưa rõ',
        age: charMatch[3]?.trim() || 'Chưa rõ',
        role: charMatch[4]?.trim() || 'Nhân vật phụ',
        appearance: charMatch[5]?.trim() || '',
        personality: charMatch[6]?.trim() || ''
      });
    }
  }

  // 3. Trích xuất các chương <CHAPTER title="...">...</CHAPTER>
  const chapterRegex = /<CHAPTER(?:\s+title="([^"]*)")?>([\s\S]*?)<\/CHAPTER>/gi;
  let match;
  let chIndex = 1;

  while ((match = chapterRegex.exec(rawText)) !== null) {
    const title = (match[1] || `Chương ${chIndex}`).trim();
    let content = match[2] || '';

    // Làm sạch triệt để các thẻ metadata còn lẫn vào nội dung chương
    content = content
      .replace(/<NEW_CHARACTER[\s\S]*?\/>/gi, '')
      .replace(/<NEW_CHARACTER[\s\S]*?<\/NEW_CHARACTER>/gi, '')
      .replace(/<STORY_SUMMARY[\s\S]*?<\/STORY_SUMMARY>/gi, '')
      .replace(/<\/?CHAPTER[^>]*>/gi, '')
      .trim();

    if (content) {
      chapters.push({
        id: `ch_${Date.now()}_${chIndex}`,
        title,
        content,
        status: 'completed'
      });
      chIndex++;
    }
  }

  // Nếu không tìm thấy thẻ <CHAPTER>, thử fallback tách theo tiêu đề "Chương X: ..."
  if (chapters.length === 0 && rawText.trim()) {
    const cleanedRaw = rawText
      .replace(/<NEW_CHARACTER[\s\S]*?\/>/gi, '')
      .replace(/<STORY_SUMMARY[\s\S]*?<\/STORY_SUMMARY>/gi, '')
      .trim();

    const parts = cleanedRaw.split(/(?=^###?\s*Chương\s+\d+|^Chương\s+\d+\s*[:\-–])/mi);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;

      const titleLineMatch = /^(?:###?\s*)?(Chương\s+\d+[^:\n]*[:\-–]?[^\n]*)/i.exec(part);
      const title = titleLineMatch ? titleLineMatch[1].trim() : `Chương ${i + 1}`;
      const content = titleLineMatch ? part.substring(titleLineMatch[0].length).trim() : part;

      if (content) {
        chapters.push({
          id: `ch_${Date.now()}_${i + 1}`,
          title,
          content,
          status: 'completed'
        });
      }
    }
  }

  return {
    chapters,
    newCharacters,
    storySummary
  };
}

/**
 * Gọi AI Writer tạo văn xuôi chương theo Batch Plan đã định sẵn.
 */
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
  const planChapters = batchPlan.chapters || [];
  const count = planChapters.length;
  const startCh = batchPlan.startChapter ?? (batchPlan as any).batchStartChapter ?? 1;
  const endCh = batchPlan.endChapter ?? (batchPlan as any).batchEndChapter ?? (startCh + count - 1);

  const sys = `Bạn là Đại Văn Hào AI chuyên nghiệp, phụ trách sáng tác văn xuôi cho tiểu thuyết dài tập (Story Engine V3).
Bạn phải viết CHÍNH XÁC ${count} chương truyện (từ Chương ${startCh} đến Chương ${endCh}) tuân thủ tuyệt đối BATCH PLAN đã đề ra.

QUY TẮC SÁNG TÁC:
1. Mỗi chương phải có dung lượng đầy đặn, giàu hình ảnh, miêu tả tâm lý và tương tác sâu sắc, KHÔNG viết lướt tóm tắt.
2. Tuân thủ triệt để kế hoạch từng cảnh trong Batch Plan.
3. Không vi phạm các vết thương, giới hạn nhân vật, và tuyệt đối KHÔNG cho nhân vật bị khóa xuất hiện.
4. ĐỊNH DẠNG ĐẦU RA BẮT BUỘC:
Bọc từng chương trong thẻ XML:
<CHAPTER title="Chương X: Tiêu đề chương">
Nội dung văn xuôi của chương...
</CHAPTER>

Nếu có nhân vật phụ mới xuất hiện lần đầu, khai báo ở cuối:
<NEW_CHARACTER name="Tên" gender="Nam/Nữ" age="Tuổi" role="Vai trò" appearance="Vẻ ngoài" personality="Tính cách" />

Nếu muốn cập nhật tóm tắt tiếp diễn cốt truyện:
<STORY_SUMMARY>
Tóm tắt ngắn gọn các sự kiện vừa diễn ra trong batch này...
</STORY_SUMMARY>`;

  const prompt = `${writerContext}

HÃY BẮT ĐẦU VIẾT TOÀN BỘ CÁC CHƯƠNG CHO BATCH NÀY THEO ĐÚNG ĐỊNH DẠNG XML YÊU CẦU:`;

  const rawOutput = await runner(prompt, sys);
  const parsed = parseChaptersAndMetadata(rawOutput);

  return {
    rawOutput,
    ...parsed
  };
}
