import type { RetrievalFilters } from "@nyz-rag/types";

/** Reject malformed filters rather than silently widening the search scope. */
export function parseRetrievalFilters(input: unknown): RetrievalFilters {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("filters must be an object");
  const result: RetrievalFilters = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === "publishedFrom" || key === "publishedTo") {
      if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")
        || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) {
        throw new Error(`${key} must be a valid YYYY-MM-DD date`);
      }
      result[key] = value;
    } else if (key === "categories" || key === "tags" || key === "scenarios") {
      if (!Array.isArray(value) || value.length > 20 || value.some((item) => typeof item !== "string" || !item.trim() || item.length > 200)) {
        throw new Error(`${key} must contain at most 20 non-empty strings (up to 200 characters each)`);
      }
      result[key] = [...new Set((value as string[]).map((item) => item.trim()))];
    } else if (key === "sourceId") {
      if (typeof value !== "string" || !value.trim() || value.length > 200) throw new Error("sourceId must be a non-empty string (up to 200 characters)");
      result.sourceId = value.trim();
    } else {
      throw new Error(`unknown filter: ${key}`);
    }
  }
  if (result.publishedFrom && result.publishedTo && result.publishedFrom > result.publishedTo) throw new Error("publishedFrom must not be after publishedTo");
  return result;
}
