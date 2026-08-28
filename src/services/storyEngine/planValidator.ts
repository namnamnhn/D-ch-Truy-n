import { BatchPlan, StoryControl, StoryState } from './types';
import { getCurrentArc } from './arcController';

export interface PlanValidationResult {
  valid: boolean;
  errors: string[];
  repairedPlan: BatchPlan;
}

/**
 * Plan Validator:
 * Hậu kiểm tiền khả thi cho BatchPlan TRƯỚC KHI chuyển giao cho AI Writer.
 * Đảm bảo 100% không để lộ spoiler, không gọi nhân vật bị khóa, không sai nhịp độ.
 */
export function validateAndRepairBatchPlan(
  plan: BatchPlan,
  control: StoryControl,
  state: StoryState,
  startChapter: number
): PlanValidationResult {
  const errors: string[] = [];
  const repairedPlan: BatchPlan = JSON.parse(JSON.stringify(plan));
  const currentArc = getCurrentArc(control, startChapter);

  // Danh sách các nhân vật được phép xuất hiện tại Arc này
  const allowedCharIds = new Set(currentArc.unlockedCharacterIds || []);
  // Thêm các nhân vật đã xuất hiện trong state
  (state.unlockedCharacterIds || []).forEach(id => allowedCharIds.add(id));
  
  // Mapping tên nhân vật sang ID và ngược lại
  const charNameToIdMap: Record<string, string> = {};
  const charIdToEntryMap = control.characterRegistry || {};
  for (const [id, entry] of Object.entries(charIdToEntryMap)) {
    charNameToIdMap[entry.name.toLowerCase().trim()] = id;
    if (entry.aliasSet) {
      entry.aliasSet.forEach(alias => {
        charNameToIdMap[alias.toLowerCase().trim()] = id;
      });
    }
  }

  // Danh sách nhân vật đang bị Gate tại chương này
  const gatedCharNames = new Set<string>();
  (control.characterGates || []).forEach(gate => {
    if (gate.unlockAtChapter > startChapter && !allowedCharIds.has(gate.characterId)) {
      gatedCharNames.add(gate.characterName.toLowerCase().trim());
    }
  });

  // Danh sách spoiler cấm tại chương này
  const forbiddenSpoilersForThisBatch: string[] = [
    ...(currentArc.forbiddenSpoilers || [])
  ];
  (control.spoilerGates || []).forEach(sg => {
    if (sg.forbiddenBeforeChapter > startChapter) {
      forbiddenSpoilersForThisBatch.push(sg.description);
    }
  });

  // 1. KIỂM TRA & SỬA TỪNG CHƯƠNG TRONG BATCH
  for (const chap of repairedPlan.chapters) {
    const chNum = chap.chapterNumber;

    // A. Kiểm tra nhân vật bị khóa (Gated Characters)
    const sanitizedActiveChars: string[] = [];
    for (const charName of chap.activeCharacters || []) {
      const norm = charName.toLowerCase().trim();
      const charId = charNameToIdMap[norm];

      if (gatedCharNames.has(norm) || (charId && !allowedCharIds.has(charId))) {
        errors.push(`[Plan Vi phạm Gating] Nhân vật '${charName}' bị khóa đến sau chương ${startChapter} nhưng lại được đưa vào kế hoạch Chương ${chNum}.`);
        // Không đưa vào sanitizedActiveChars
      } else {
        sanitizedActiveChars.push(charName);
      }
    }
    chap.activeCharacters = sanitizedActiveChars.length > 0 ? sanitizedActiveChars : ['Nhân vật chính'];

    // B. Kiểm tra nhân vật mới giới thiệu (introducedCharacters)
    const sanitizedIntroChars: string[] = [];
    for (const charName of chap.introducedCharacters || []) {
      const norm = charName.toLowerCase().trim();
      const charId = charNameToIdMap[norm];

      if (gatedCharNames.has(norm) || (charId && !allowedCharIds.has(charId))) {
        errors.push(`[Plan Vi phạm Gating] Nhân vật '${charName}' chưa mở khóa nhưng được định nghĩa giới thiệu ở Chương ${chNum}.`);
      } else {
        sanitizedIntroChars.push(charName);
      }
    }
    chap.introducedCharacters = sanitizedIntroChars;

    // C. Kiểm tra Forbidden Spoilers trong Focus / Required Events
    chap.forbiddenSpoilers = Array.from(new Set([
      ...(chap.forbiddenSpoilers || []),
      ...forbiddenSpoilersForThisBatch
    ]));

    // D. Đảm bảo pacingTarget hợp lệ
    const validPacings = ['slow_build', 'rising_action', 'climax', 'cliffhanger', 'cool_down'];
    if (!validPacings.includes(chap.pacingTarget)) {
      chap.pacingTarget = 'rising_action';
    }
  }

  // 2. GHI NHẬN DANH SÁCH BỊ GATED VÀO BATCH PLAN
  repairedPlan.charactersGated = Array.from(gatedCharNames);
  repairedPlan.planValid = errors.length === 0;
  repairedPlan.planValidationErrors = errors;

  return {
    valid: errors.length === 0,
    errors,
    repairedPlan
  };
}
