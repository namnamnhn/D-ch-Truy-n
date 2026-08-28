// Sửa 2 dạng lỗi thường gặp do AI dịch bị "vấp" khi sinh văn bản (không phải lỗi convert từ
// nguồn, mà lỗi PHÁT SINH trong lúc dịch): (1) lặp nguyên 1 từ liền kề nhau 2 lần trở lên
// ("cấp dưới DƯỚI quyền nó", "quen biết BIẾT bao nhiêu"...), và (2) một số từ bị AI viết sai
// chính tả/dấu theo kiểu lặp lại nhất quán ("uể ỦẢI" thay vì "uể OẢI"). Gộp cả 2 vào 1 file vì
// cùng mục đích: dọn sạch output AI trước khi lưu làm bản dịch cuối, chạy NGAY SAU
// formatBookStyle/fixMergedTitle trong applyBatchResults.ts.

// ----------------------------------------------------------------------------------------------
// 1) LẶP TỪ LIỀN KỀ
// ----------------------------------------------------------------------------------------------
// Tiếng Việt có rất nhiều từ láy hoàn toàn (lặp nguyên âm tiết, cố ý, đúng ngữ pháp): "từ từ",
// "xa xa", "người người", "nhà nhà", "ngày ngày", "dần dần", "lâu lâu", "thường thường"... Vì
// vậy KHÔNG được xoá mù mọi cặp từ trùng liền kề — chỉ xoá khi từ đó không nằm trong danh sách
// láy hợp lệ dưới đây. Danh sách này ưu tiên "thà bỏ sót còn hơn sửa nhầm" (false negative an
// toàn hơn false positive) — nếu sau này phát hiện thêm từ láy hợp lệ bị sửa nhầm, chỉ cần thêm
// vào set này.
const VALID_REDUPLICATED_WORDS = new Set<string>([
    'từ', 'xa', 'gần', 'lâu', 'thường', 'vừa', 'đời', 'mãi', 'dần', 'người', 'nhà', 'ngày',
    'năm', 'đêm', 'chốc', 'thoáng', 'hay', 'ầm', 'rào', 'ào', 'ù', 'vù', 'rưng', 'run', 'đều',
    'chăm', 'khăng', 'chằm', 'đau', 'nơi', 'chỗ', 'đứa', 'con', 'cái', 'từng', 'mỗi', 'nào',
    'ai', 'đâu', 'sao', 'gì', 'chi', 'nhau', 'là', 'càng', 'thoi', 'phần', 'nhè', 'khe', 'sẽ',
]);

/**
 * Xoá các lượt lặp liền kề của CÙNG 1 âm tiết (không phân biệt hoa/thường, giữ nguyên dạng xuất
 * hiện lần đầu) — trừ khi âm tiết đó nằm trong danh sách từ láy hợp lệ ở trên.
 * VD: "cấp dưới dưới quyền" -> "cấp dưới quyền"; "quan quan bao che" -> "quan bao che";
 *     nhưng "đi từ từ thôi" -> giữ nguyên (từ láy hợp lệ).
 *
 * LƯU Ý KỸ THUẬT: cố tình KHÔNG dùng \b để đánh dấu biên từ — \b trong JS regex chỉ nhận diện
 * [A-Za-z0-9_] là "word char", chữ Việt có dấu (ề, ó, ư...) bị coi là KHÔNG PHẢI word char, nên
 * \b tạo ranh giới ảo ngay GIỮA 1 từ có dấu (vd giữa "n" và "ó" trong "nó"), làm regex khớp nhầm
 * xuyên qua ranh giới 2 từ khác nhau ("...quyền nó" từng bị ăn nhầm thành "...quyềnó" khi test).
 * Dùng đúng kiểu biên `(^|[^\p{L}\p{N}_])` / lookahead `(?=[^\p{L}\p{N}_]|$)` đã dùng ở
 * `buildRuleRegex` (ruleFixing.ts) — an toàn với mọi ký tự Unicode chữ Việt.
 */
export const collapseDuplicateWords = (text: string): string => {
    if (!text) return text;
    const regex = /(^|[^\p{L}\p{N}_])(\p{L}+)(?:[ \t]+\2)+(?=[^\p{L}\p{N}_]|$)/gu;
    return text.replace(regex, (match: string, prefix: string, word: string) => {
        if (VALID_REDUPLICATED_WORDS.has(word.toLowerCase())) return match;
        return prefix + word;
    });
};

// ----------------------------------------------------------------------------------------------
// 2) LỖI CHÍNH TẢ LẶP LẠI CÓ QUY LUẬT (do AI hay viết sai 1 kiểu, nhiều chương khác nhau)
// ----------------------------------------------------------------------------------------------
// Khác lỗi convert nguồn (đã có ruleFixing.ts cho người dùng tự nhập Sai->Đúng theo từng
// truyện) — đây là danh sách CỐ ĐỊNH, ÁP DỤNG SẴN cho MỌI truyện vì đã xác nhận là lỗi
// chính tả AI hay mắc (không phải văn phong/tuỳ truyện). Chỉ thêm từ vào đây khi đã xác nhận
// chắc chắn "wrong" không phải là 1 từ đúng khác trong tiếng Việt (tránh sửa nhầm).
const KNOWN_TYPO_FIXES: { wrong: string; right: string }[] = [
    { wrong: 'uể ủai', right: 'uể oải' },
];

const buildTypoRegex = (wrong: string): RegExp => {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(^|[^\\p{L}\\p{N}_])(${escaped})(?=[^\\p{L}\\p{N}_]|$)`, 'giu');
};

export const fixKnownTypos = (text: string): string => {
    if (!text) return text;
    let result = text;
    for (const { wrong, right } of KNOWN_TYPO_FIXES) {
        result = result.replace(buildTypoRegex(wrong), (_m, prefix) => prefix + right);
    }
    return result;
};

/** Gộp cả 2 bước, gọi 1 lần duy nhất trong pipeline dịch. */
export const cleanupAiTextArtifacts = (text: string): string => {
    if (!text) return text;
    return fixKnownTypos(collapseDuplicateWords(text));
};
