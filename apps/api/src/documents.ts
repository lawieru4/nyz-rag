import type { FastifyPluginAsync } from "fastify";
import { getDocumentDetail } from "@nyz-rag/processing";

export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
    const document = await getDocumentDetail(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    return document;
  });
};
