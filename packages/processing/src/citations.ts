// Pure syntactic checks only: citation presence/IDs do not verify evidence or claims.
export const INSUFFICIENT_EVIDENCE_ANSWER = "参考资料不足以回答该问题，请补充问题中的对象、条件或相关资料。";

export interface CitationStats {
  cited: number[];
  invalid: number[];
  /** Source article's citation number, or null when absent from the context. */
  sourceCitation: number | null;
  sourceCited: boolean;
}

// [1], [1][2], and grouped forms [1, 2] / [1、2].
const CITATION = /\[(\d+(?:\s*[,，、]\s*\d+)*)\]/g;

export function citedNumbers(answer: string): number[] {
  const numbers = new Set<number>();
  for (const match of answer.matchAll(CITATION)) for (const value of match[1].split(/\s*[,，、]\s*/)) numbers.add(Number(value));
  return [...numbers].sort((a, b) => a - b);
}

export function validateCitations(answer: string, sourceCount: number): { cited: number[]; invalid: number[] } {
  const cited = citedNumbers(answer);
  return { cited, invalid: cited.filter((value) => value < 1 || value > sourceCount) };
}

/** Sources are ordered by citation number (item n corresponds to [n]). */
export function citationStats(answer: string, sources: Array<{ articleKey: string }>, sourceArticleKeys: string[]): CitationStats {
  const stats = validateCitations(answer, sources.length);
  const index = sources.findIndex((source) => sourceArticleKeys.includes(source.articleKey));
  const sourceCitation = index >= 0 ? index + 1 : null;
  return { ...stats, sourceCitation, sourceCited: sourceCitation !== null && stats.cited.includes(sourceCitation) };
}
