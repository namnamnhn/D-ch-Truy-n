import { ChapterMemory } from './types';

/**
 * Tính điểm liên quan cho từng ký ức chương dựa trên recency, characters, clues, seeds, injuries, relationship changes.
 */
export function scoreMemoryRelevance(
  mem: ChapterMemory,
  activeCharNames: string[],
  currentChapter: number
): number {
  const charNameSet = new Set(activeCharNames.map(n => n.toLowerCase().trim()));
  let score = 0;

  // 1. Khoảng cách thời gian (chương càng gần thì càng quan trọng)
  const recencyDistance = currentChapter - mem.chapterNumber;
  if (recencyDistance <= 5) score += 50;
  else if (recencyDistance <= 15) score += 30;
  else if (recencyDistance <= 30) score += 15;

  // 2. Nhân vật liên quan xuất hiện
  if (Array.isArray(mem.charactersInvolved)) {
    for (const charName of mem.charactersInvolved) {
      if (charNameSet.has(charName.toLowerCase().trim())) {
        score += 25;
      }
    }
  }

  // 3. Có manh mối chưa giải quyết hoặc hạt giống dài hạn / biến cố
  if (mem.clues && mem.clues.length > 0) score += 20;
  if (mem.longTermSeeds && mem.longTermSeeds.length > 0) score += 25;
  if (mem.injuries && mem.injuries.length > 0) score += 20;
  if (mem.relationshipChanges && mem.relationshipChanges.length > 0) score += 15;

  return score;
}

/**
 * Trích xuất và định dạng các ký ức chương liên quan nhất cho Context Builder.
 */
export function retrieveRelevantMemories(
  memoryIndex: ChapterMemory[] | undefined,
  activeCharNames: string[],
  currentChapter: number,
  maxMemories: number = 6
): ChapterMemory[] {
  if (!memoryIndex || memoryIndex.length === 0) return [];

  // Chấm điểm liên quan cho từng ký ức chương
  const scored = memoryIndex.map(mem => ({
    mem,
    score: scoreMemoryRelevance(mem, activeCharNames, currentChapter)
  }));

  // Sắp xếp theo điểm giảm dần và lấy top
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxMemories).map(s => s.mem);
}

/**
 * Định dạng danh sách ký ức thành chuỗi prompt gọn gàng
 */
export function formatMemoriesForContext(memories: ChapterMemory[]): string {
  if (!memories || memories.length === 0) return 'Chưa có dữ liệu ký ức các chương trước.';

  return memories
    .sort((a, b) => a.chapterNumber - b.chapterNumber)
    .map(m => {
      const items: string[] = [];
      if (m.summary) items.push(`Tóm tắt: ${m.summary}`);
      if (m.charactersInvolved?.length) items.push(`Nhân vật: ${m.charactersInvolved.join(', ')}`);
      if (m.locations?.length) items.push(`Địa điểm: ${m.locations.join(', ')}`);
      if (m.injuries?.length) items.push(`Thương tích/Biến cố: ${m.injuries.join('; ')}`);
      if (m.relationshipChanges?.length) items.push(`Thay đổi quan hệ: ${m.relationshipChanges.join('; ')}`);
      if (m.clues?.length) items.push(`Manh mối phát hiện: ${m.clues.join('; ')}`);
      if (m.longTermSeeds?.length) items.push(`Hạt giống cài cắm: ${m.longTermSeeds.join('; ')}`);
      return `[Chương ${m.chapterNumber}: ${m.title || 'Không tiêu đề'}]\n${items.join('\n')}`;
    })
    .join('\n\n');
}
