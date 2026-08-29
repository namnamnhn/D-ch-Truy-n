import { Character } from '../../types';
import { StoryControl, ArcDefinition, CharacterGate, SpoilerGate } from './types';
import { getArcForChapter } from './storyAccess';

export { getArcForChapter } from './storyAccess';

/**
 * Tìm Arc hiện tại dựa trên số chương tiếp theo cần viết.
 */
export function getCurrentArc(control: StoryControl, nextChapter: number): ArcDefinition {
  return getArcForChapter(control, nextChapter);
}

/**
 * Tính toán tiến độ của Arc hiện tại (0.0 đến 1.0).
 */
export function calculateArcProgress(arc: ArcDefinition, nextChapter: number): {
  arcLength: number;
  arcChapterIndex: number;
  arcProgress: number;
  isNearClimax: boolean;
} {
  const arcLength = Math.max(1, arc.endChapter - arc.startChapter + 1);
  const arcChapterIndex = Math.max(0, nextChapter - arc.startChapter);
  const arcProgress = Math.min(1, Math.max(0, arcChapterIndex / arcLength));
  const isNearClimax = nextChapter >= (arc.climaxChapter || (arc.endChapter - 2));

  return {
    arcLength,
    arcChapterIndex,
    arcProgress,
    isNearClimax
  };
}

/**
 * Lọc danh sách nhân vật cho chương hiện tại:
 * - Nhân vật đã mở khóa (unlockCondition hoặc gate hợp lệ) được chuyển cho AI.
 * - Nhân vật tương lai bị LOẠI BỎ hoàn toàn khỏi Writer context.
 */
export function filterCharactersForChapter(
  allCharacters: Character[],
  characterGates: CharacterGate[],
  nextChapter: number,
  control?: StoryControl
): {
  activeCharacters: Character[];
  lockedCharacters: CharacterGate[];
} {
  const gateMap = new Map<string, CharacterGate>();
  for (const gate of (characterGates || [])) {
    gateMap.set(gate.characterName.toLowerCase().trim(), gate);
    if (gate.characterId) gateMap.set(gate.characterId.toLowerCase().trim(), gate);
  }

  const currentArc = control ? getCurrentArc(control, nextChapter) : null;
  const allowedIds = new Set<string>(currentArc?.unlockedCharacterIds || []);

  const activeCharacters: Character[] = [];
  const lockedCharacters: CharacterGate[] = [];

  for (const char of allCharacters) {
    const key = char.name.toLowerCase().trim();
    const idKey = char.id?.toLowerCase().trim() || '';
    const gate = gateMap.get(key) || gateMap.get(idKey);

    if (allowedIds.has(char.id) || allowedIds.has(char.name)) {
      activeCharacters.push(char);
      continue;
    }

    if (!gate) {
      // Không có quy tắc hạn chế -> Mặc định kích hoạt
      activeCharacters.push(char);
    } else {
      if (gate.unlockAtChapter <= nextChapter) {
        activeCharacters.push(char);
      } else {
        lockedCharacters.push(gate);
      }
    }
  }

  // Thêm các gate có trong StoryControl nhưng chưa có profile trong allCharacters
  for (const gate of (characterGates || [])) {
    if (gate.unlockAtChapter > nextChapter) {
      if (!lockedCharacters.some(l => l.characterName.toLowerCase() === gate.characterName.toLowerCase())) {
        lockedCharacters.push(gate);
      }
    }
  }

  return {
    activeCharacters,
    lockedCharacters
  };
}

/**
 * Lọc các bí mật cốt truyện theo Spoiler Gate cho chương hiện tại.
 */
export function filterSpoilersForChapter(
  spoilerGates: SpoilerGate[],
  nextChapter: number
): {
  allowedReveals: SpoilerGate[];
  forbiddenSpoilers: SpoilerGate[];
} {
  const allowedReveals: SpoilerGate[] = [];
  const forbiddenSpoilers: SpoilerGate[] = [];

  for (const gate of (spoilerGates || [])) {
    if (nextChapter >= gate.forbiddenBeforeChapter) {
      allowedReveals.push(gate);
    } else {
      forbiddenSpoilers.push(gate);
    }
  }

  return {
    allowedReveals,
    forbiddenSpoilers
  };
}

/**
 * Nhận diện gợi ý chuyển giao Arc tiếp theo (chỉ xuất hiện khi Arc hiện tại đạt >= 85% tiến độ).
 */
export function getTransitionPreview(
  control: StoryControl,
  currentArc: ArcDefinition,
  nextChapter: number
): string | null {
  const { arcProgress } = calculateArcProgress(currentArc, nextChapter);
  if (arcProgress < 0.85) return null;

  const currentIdx = control.arcs.findIndex(a => a.id === currentArc.id);
  if (currentIdx < 0 || currentIdx >= control.arcs.length - 1) return null;

  const nextArc = control.arcs[currentIdx + 1];
  return `[GỢI Ý CHUYỂN GIAO GIAI ĐOẠN]
Giai đoạn hiện tại (${currentArc.title}) đã gần kết thúc (${Math.round(arcProgress * 100)}%).
Giai đoạn tiếp theo sẽ là: "${nextArc.title}" (bắt đầu từ chương ${nextArc.startChapter}).
LƯU Ý NGHIÊM NGẶT: Chỉ chuẩn bị không khí hoặc gợi ý mầm mống mờ nhạt. TUYỆT ĐỐI KHÔNG giải quyết hoặc khởi động các xung đột chính của Giai đoạn tiếp theo trước chương ${nextArc.startChapter}!`;
}
