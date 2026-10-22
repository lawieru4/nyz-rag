import type { FastifyPluginAsync } from "fastify";
import { keywordSearchChunks, parseRetrievalFilters, searchTerms } from "@nyz-rag/processing";
import type { RetrievalFilters, SearchRequest, SearchResult } from "@nyz-rag/types";

export const searchRoutes: FastifyPluginAsync = async (app) => {
  // Keyword-only search; return the highest-scoring chunk from each article.
  app.post<{ Body: SearchRequest }>("/api/search", async (request, reply) => {
    const query = request.body.query.trim();
    let filters: RetrievalFilters;
    try { filters = parseRetrievalFilters(request.body.filters); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
    const results: SearchResult[] = [];
    for (const hit of await keywordSearchChunks(searchTerms(query).slice(0, 64), 100, undefined, filters)) {
      if (results.length >= 20) break;
      if (results.some((result) => result.documentId === hit.documentId)) continue;
      results.push({ documentId: hit.documentId, title: hit.title, url: hit.url, excerpt: hit.content.slice(0, 160), score: hit.score });
    }
    return { query, results, total: results.length };
  });
};
