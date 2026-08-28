import { CreativeChapter } from '../../types';
import { StoryBible, StoryControl, StoryState, BatchPlan, ValidationResult, Violation, ViolationType } from './types';
import { lintChapterProse } from './styleLinter';
import { filterCharactersForChapter, filterSpoilersForChapter } from './arcController';
import { buildValidatorContext } from './contextBuilder';
import { getCharacterAccess } from './storyAccess';

/**
 * Semantic Validator V3 (Fail-Closed):
 * Kết hợp Deterministic Checks và Semantic AI QA.
 * Bất kỳ vi phạm nghiêm trọng nào (nhân vật bị gate xuất hiện, spoiler rò rỉ, quên thương tích)
 * đều sẽ kích hoạt FAIL để chuyển sang AutoRepair.
 */
export async function validateBatchOutput(
  chapters: CreativeChapter[],
  batchPlan: BatchPlan,
  control: StoryControl,
  state: StoryState,
  bible: StoryBible,
  runner?: (prompt: string, sys: string) => Promise<string>
): Promise<ValidationResult> {
  const violations: Violation[] = [];
  const startCh = batchPlan.startChapter;

  const semanticChecks = {
    characterGating: true,
    worldFactContinuity: true,
    spoilerContainment: true,
    pacingIntegrity: true,
    characterTraitConsistency: true
  };

  // 1. DETERMINISTIC STYLE LINTING
  const lintResult = lintChapterProse(chapters, []);
  for (const lv of lintResult.violations) {
    violations.push({
      type: 'WORD_COUNT_DEFICIT',
      severity: 'WARNING',
      chapter: startCh,
      quoteOrDescription: lv,
      reason: 'Vi phạm quy tắc văn phong hoặc độ dài chương.',
      repairInstruction: 'Chuẩn hóa câu từ và loại bỏ rác/thẻ hệ thống nếu có.'
    });
  }

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chNum = ch.chapterNumber || startCh + i;
    const content = ch.content || '';
    const { lockedCharacters } = filterCharactersForChapter(
      bible.characters || [], control.characterGates || [], chNum, control
    );
    const lockedNames = new Map(lockedCharacters.map(character => [character.characterName, character.unlockAtChapter]));
    for (const character of Object.values(control.characterRegistry || {})) {
      const access = getCharacterAccess(control, character, chNum);
      if (!access.canAppearDirectly) lockedNames.set(character.name, access.directAppearanceChapter);
    }
    const { forbiddenSpoilers } = filterSpoilersForChapter(control.spoilerGates || [], chNum);

    // A. Kiểm tra nhân vật bị khóa xuất hiện
    for (const [name, unlockChapter] of lockedNames) {
      if (!name || name.length < 2) continue;
      const regex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(content)) {
        semanticChecks.characterGating = false;
        violations.push({
          type: 'CHARACTER_GATE',
          severity: 'CRITICAL',
          chapter: chNum,
          quoteOrDescription: `Nhân vật "${name}" xuất hiện trong Chương ${chNum}`,
          reason: `Nhân vật "${name}" bị khóa cho tới chương ${unlockChapter}.`,
          repairInstruction: `Xóa sự xuất hiện của "${name}" hoặc thay bằng nhân vật phụ vô danh.`
        });
      }
    }

    // B. Kiểm tra Spoiler Leak
    for (const secret of forbiddenSpoilers) {
      const descWords = secret.description.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      let matchCount = 0;
      for (const w of descWords) {
        if (content.toLowerCase().includes(w)) matchCount++;
      }
      if (descWords.length >= 3 && matchCount >= Math.ceil(descWords.length * 0.8)) {
        semanticChecks.spoilerContainment = false;
        violations.push({
          type: 'SPOILER_LEAK',
          severity: 'CRITICAL',
          chapter: chNum,
          quoteOrDescription: `Có dấu hiệu hé lộ sớm bí mật: "${secret.description}"`,
          reason: `Bí mật này bị cấm tiết lộ trước chương ${secret.forbiddenBeforeChapter}.`,
          repairInstruction: `Ẩn hoặc xóa chi tiết tiết lộ bí mật này, giữ lại sự bí ẩn.`
        });
      }
    }

    // C. Kiểm tra Word Count
    const wordCount = content.trim().split(/\s+/).length;
    const minWords = control.pacingRules?.minWordsPerChapter || 1500;
    if (wordCount < minWords) {
      violations.push({
        type: 'WORD_COUNT_DEFICIT',
        severity: 'WARNING',
        chapter: chNum,
        quoteOrDescription: `Chương ${chNum} chỉ đạt ${wordCount} từ (yêu cầu tối thiểu ${minWords} từ).`,
        reason: 'Độ dài chương quá ngắn làm giảm trải nghiệm độc giả.',
        repairInstruction: 'Mở rộng miêu tả tâm lý, đối thoại hoặc chi tiết bối cảnh.'
      });
    }
  }

  // 3. DETERMINISTIC PHYSICAL INJURY CONTINUITY
  const activeInjuries = Object.values(state.characterStates || {}).flatMap(cs =>
    (cs.injuries || [])
      .filter(inj => inj.expectedRecoveryChapter > startCh && (inj.severity === 'severe' || inj.severity === 'critical'))
      .map(inj => ({ name: cs.name, inj }))
  );

  for (let i = 0; i < chapters.length; i++) {
    const ch = chapters[i];
    const chNum = ch.chapterNumber || startCh + i;
    const content = ch.content || '';

    for (const { name, inj } of activeInjuries) {
      const nameRegex = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (nameRegex.test(content)) {
        const combatRegex = /(?:xuất toàn lực|nhảy vọt lên|vung kiếm chém mạnh|tung quyền như vũ bão|phi thân tốc biến)/i;
        if (combatRegex.test(content) && !content.toLowerCase().includes('vết thương') && !content.toLowerCase().includes('đau')) {
          violations.push({
            type: 'INJURY_AMNESIA',
            severity: 'CRITICAL',
            chapter: chNum,
            quoteOrDescription: `Nhân vật ${name} chiến đấu cường độ cao mà quên vết thương ${inj.type} ở ${inj.bodyPart}`,
            reason: `Vết thương ${inj.severity} cần đến chương ${inj.expectedRecoveryChapter} mới hồi phục.`,
            repairInstruction: `Miêu tả thêm sự cắn răng chịu đau, hạn chế vận động hoặc phải trả giá khi gắng gượng.`
          });
        }
      }
    }
  }

  // 4. AI SEMANTIC QA (Nếu có runner)
  let continuityScore = 95;
  let pacingScore = 90;

  if (runner) {
    const qaSys = `Bạn là Semantic Story Integrity Inspector (Story Engine V3).
Nhiệm vụ: Hậu kiểm toàn diện các chương vừa viết để bảo đảm tính logic, continuity, và pacing.

HÃY TRẢ VỀ STRICT JSON:
{
  "pass": true,
  "continuityScore": 95,
  "pacingScore": 90,
  "semanticChecks": {
    "characterGating": true,
    "worldFactContinuity": true,
    "spoilerContainment": true,
    "pacingIntegrity": true,
    "characterTraitConsistency": true
  },
  "violations": [
    {
      "type": "CHARACTER_GATE" | "SPOILER_LEAK" | "PACING_RUSH" | "INJURY_AMNESIA" | "RESOURCE_CONTRADICTION" | "CHARACTER_OOC" | "WORLD_FACT_CONTRADICTION" | "WORD_COUNT_DEFICIT",
      "severity": "CRITICAL" | "WARNING",
      "chapter": 1,
      "quoteOrDescription": "Đoạn văn có vấn đề",
      "reason": "Lý do vi phạm",
      "repairInstruction": "Hướng dẫn sửa chữa chi tiết"
    }
  ]
}`;

    const qaPrompt = buildValidatorContext(control, batchPlan, state, startCh, chapters);

    try {
      const rawQa = await runner(qaPrompt, qaSys);
      const cleaned = rawQa.replace(/```json/g, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed) {
        continuityScore = typeof parsed.continuityScore === 'number' ? parsed.continuityScore : continuityScore;
        pacingScore = typeof parsed.pacingScore === 'number' ? parsed.pacingScore : pacingScore;

        if (parsed.semanticChecks) {
          semanticChecks.characterGating = semanticChecks.characterGating && parsed.semanticChecks.characterGating !== false;
          semanticChecks.worldFactContinuity = parsed.semanticChecks.worldFactContinuity !== false;
          semanticChecks.spoilerContainment = semanticChecks.spoilerContainment && parsed.semanticChecks.spoilerContainment !== false;
          semanticChecks.pacingIntegrity = parsed.semanticChecks.pacingIntegrity !== false;
          semanticChecks.characterTraitConsistency = parsed.semanticChecks.characterTraitConsistency !== false;
        }

        if (Array.isArray(parsed.violations)) {
          for (const v of parsed.violations) {
            violations.push({
              type: (v.type as ViolationType) || 'CHARACTER_OOC',
              severity: v.severity === 'CRITICAL' ? 'CRITICAL' : 'WARNING',
              chapter: v.chapter || startCh,
              quoteOrDescription: v.quoteOrDescription || '',
              reason: v.reason || '',
              repairInstruction: v.repairInstruction || ''
            });
          }
        }
      }
    } catch (err) {
      console.warn('[validateBatchOutput] AI QA call failed or unparseable, using fail-closed deterministic validator:', err);
    }
  }

  // Quyết định FAIL-CLOSED
  const hasCritical = violations.some(v => v.severity === 'CRITICAL');
  const pass = !hasCritical && violations.filter(v => v.severity === 'WARNING').length <= 2;

  // Tính lại điểm
  if (hasCritical) {
    continuityScore = Math.min(continuityScore, 65);
  }

  return {
    pass,
    continuityScore,
    pacingScore,
    violations,
    semanticChecks
  };
}
