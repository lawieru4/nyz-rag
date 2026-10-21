// 关键词检索的词项：索引与查询使用同一套规则，不依赖数据库分词器和 locale。
// NFKC 把全角字符与化学式上下标转为普通字符（Na₀.₉ → na0.9），中文连续字符生成重叠二元组，英文与数字按词切分。

// 统一表意文字（含扩展 A）与兼容表意文字；标点不参与。
const TOKEN = /[\u3400-\u9fff\uf900-\ufaff]+|[a-z0-9]+(?:\.[0-9]+[a-z0-9]*)*/g;
const HAN = /^[\u3400-\u9fff\uf900-\ufaff]/;

export const normalizeSearchText = (text: string) => text.normalize("NFKC").toLowerCase();

/** 词项及出现次数：中文单字（独立出现时）与重叠二元组，长度为 2～64 的英文/数字词。 */
export function termCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  const add = (term: string) => counts.set(term, (counts.get(term) ?? 0) + 1);
  for (const [token] of normalizeSearchText(text).matchAll(TOKEN)) {
    if (!HAN.test(token)) {
      // 过长的串（哈希、编码）不作为词项，也避免超出 tsvector 词位长度限制。
      if (token.length >= 2 && token.length <= 64) add(token);
      continue;
    }
    const chars = [...token];
    if (chars.length === 1) add(token);
    for (let index = 0; index + 1 < chars.length; index += 1) add(chars[index] + chars[index + 1]);
  }
  return counts;
}

/** 去重后的词项，按首次出现的顺序。 */
export const searchTerms = (text: string): string[] => [...termCounts(text).keys()];
