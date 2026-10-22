import type { FastifyPluginAsync } from "fastify";
import { createKnowledgeBase, listKnowledgeBases, updateKnowledgeBase } from "@nyz-rag/processing";
import type { SaveKnowledgeBaseRequest } from "@nyz-rag/types";

export const knowledgeBaseRoutes: FastifyPluginAsync = async (app) => {
  app.get("/api/admin/knowledge-bases", async () => listKnowledgeBases());

  app.post<{ Body: SaveKnowledgeBaseRequest }>("/api/admin/knowledge-bases", async (request, reply) => {
    return reply.code(201).send(await createKnowledgeBase({ ...request.body, name: request.body.name.trim() }));
  });

  app.patch<{ Params: { id: string }; Body: SaveKnowledgeBaseRequest }>("/api/admin/knowledge-bases/:id", async (request, reply) => {
    const updated = await updateKnowledgeBase(request.params.id, { ...request.body, name: request.body.name.trim() });
    if (!updated) return reply.code(404).send({ error: "knowledge base not found" });
    return updated;
  });
};
