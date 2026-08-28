import { CreativeChapter } from '../../types';
import { BatchPlan, Violation } from './types';
import { parseChaptersAndMetadata } from './writer';

/**
 * Auto Repair Engine:
 * Nhận văn bản bị từ chối cùng danh sách vi phạm và chỉ dẫn sửa chữa,
 * gọi AI Writer viết lại hoặc chỉnh sửa chính xác các đoạn lỗi.
 */
export async function repairBatchOutput(
  rejectedChapters: CreativeChapter[],
  rawText: string,
  violations: Violation[],
  batchPlan: BatchPlan,
  writerContext: string,
  runner: (prompt: string, sys: string) => Promise<string>
): Promise<{
  chapters: CreativeChapter[];
  rawOutput: string;
}> {
  const violationSummary = violations.map((v, i) =>
    `${i + 1}. [LỖI: ${v.type}] Chương ${v.chapter}:
- Vấn đề: ${v.quoteOrDescription}
- Lý do: ${v.reason}
- CHỈ DẪN SỬA CHỮA: ${v.repairInstruction}`
  ).join('\n\n');

  const sys = `Bạn là Auto Repair AI Editor cho tiểu thuyết.
Bản thảo các chương vừa viết đã BỊ TỪ CHỐI do vi phạm các quy tắc Continuity, Gating, Pacing hoặc Văn phong.

NHIỆM VỤ CỦA BẠN:
Viết lại hoặc sửa chữa toàn bộ các chương trong Batch để khắc phục 100% các vi phạm được liệt kê.
Định dạng đầu ra BẮT BUỘC giữ nguyên:
<CHAPTER title="Chương X: Tiêu đề chương">
Nội dung văn xuôi đã sửa hoàn chỉnh...
</CHAPTER>`;

  const prompt = `${writerContext}

[DANH SÁCH CÁC VI PHẠM BẮT BUỘC PHẢI SỬA]
${violationSummary}

[BẢN THẢO BỊ TỪ CHỐI CẦN SỬA ĐỔI]
${rejectedChapters.map(c => `=== ${c.title} ===\n${c.content}`).join('\n\n')}

HÃY VIẾT LẠI TOÀN BỘ CÁC CHƯƠNG ĐÃ ĐƯỢC SỬA HOÀN TOÀN HỢP LỆ VÀ ĐẦY ĐỦ VĂN PHONG:`;

  const rawOutput = await runner(prompt, sys);
  const parsed = parseChaptersAndMetadata(rawOutput);

  return {
    chapters: parsed.chapters,
    rawOutput
  };
}
