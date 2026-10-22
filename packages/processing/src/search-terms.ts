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

// ---- 元数据加权 ----

/** 参与检索加权的文档元数据字段。机构、期刊等字段在解析器提取后加入。 */
export type MetadataSearchField = "projectName" | "principal" | "institution" | "keywords";

// 字段权重乘在词项 IDF 上。关键词已写入切片上下文、在正文 BM25 中计过一次，权重较低。
export const METADATA_FIELD_WEIGHTS: Record<MetadataSearchField, number> = { projectName: 1, principal: 1, institution: 0.8, keywords: 0.5 };

/** 只读取检索用到的字段，兼容旧版本解析结果缺失的字段。 */
export interface SearchableMetadata {
  sourceMeta?: { keywords?: string[] | null } | null;
  projectMeta?: { name?: string | null; principal?: string | null; institution?: string | null; keywords?: string[] | null } | null;
}

/** 各字段的检索文本；关键词逐行分隔，避免相邻关键词拼出跨词的二元组。 */
export function metadataSearchFields(metadata: SearchableMetadata | null | undefined): Partial<Record<MetadataSearchField, string>> {
  const project = metadata?.projectMeta;
  const keywords = [...new Set([...(metadata?.sourceMeta?.keywords ?? []), ...(project?.keywords ?? [])])];
  const fields: Partial<Record<MetadataSearchField, string>> = {};
  if (project?.name) fields.projectName = project.name;
  if (project?.principal) fields.principal = project.principal;
  if (project?.institution) fields.institution = project.institution;
  if (keywords.length) fields.keywords = keywords.join("\n");
  return fields;
}

/** 元数据中出现的全部词项（写入 documents.metadata_search_vector）。 */
export const metadataSearchTerms = (metadata: SearchableMetadata | null | undefined): string[] =>
  [...new Set(Object.values(metadataSearchFields(metadata)).flatMap(searchTerms))];

/** 每个词项在该文档元数据中命中字段的最高权重；同一词项出现在多个字段时不重复计分。 */
export function metadataTermWeights(metadata: SearchableMetadata | null | undefined): Map<string, number> {
  const weights = new Map<string, number>();
  for (const [field, text] of Object.entries(metadataSearchFields(metadata)) as [MetadataSearchField, string][]) {
    for (const term of searchTerms(text)) weights.set(term, Math.max(weights.get(term) ?? 0, METADATA_FIELD_WEIGHTS[field]));
  }
  return weights;
}

/** 元数据加分：查询词项中命中该文档元数据的部分，按 IDF × 字段权重累加。 */
export function metadataScore(metadata: SearchableMetadata | null | undefined, terms: { term: string; idf: number }[]): number {
  if (!terms.length) return 0;
  const weights = metadataTermWeights(metadata);
  return terms.reduce((score, { term, idf }) => score + idf * (weights.get(term) ?? 0), 0);
}
