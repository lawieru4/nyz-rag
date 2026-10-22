import type { FastifyPluginAsync } from "fastify";
import {
  deleteDocument, getDocument, getDocumentDetail, getDocumentSummary, listDocuments, listModelProviders,
  selectEmbeddingProvider, setEmbeddingState, setProcessingState,
} from "@nyz-rag/processing";
import type { DocumentListResponse } from "@nyz-rag/types";
import { pageParams } from "./common.js";
import type { DocumentQueue } from "./queue.js";

export const documentRoutes: FastifyPluginAsync<{ queue: DocumentQueue }> = async (app, { queue }) => {
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
    const document = await getDocumentDetail(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    return document;
  });

  app.get<{ Querystring: { query?: string; sourceId?: string; status?: string; page?: string; pageSize?: string } }>("/api/admin/documents", async (request): Promise<DocumentListResponse> => {
    const { query = "", sourceId, status, page = "1", pageSize = "20" } = request.query;
    return listDocuments({ query, sourceId, status, ...pageParams(page, pageSize) });
  });

  app.get<{ Params: { id: string } }>("/api/admin/documents/:id", async (request, reply) => {
    const document = await getDocument(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    return document;
  });

  app.post<{ Params: { id: string } }>("/api/admin/documents/:id/reprocess", async (request, reply) => {
    const document = await getDocumentSummary(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    if (await queue.hasDocumentJob(document)) return reply.code(409).send({ error: "document already has a processing job" });
    // Persist pending state before enqueueing so a fast worker cannot be overwritten.
    await setProcessingState(document.id, "pending");
    try {
      await queue.enqueueDocument("reprocess-document", document.id);
    } catch (error) {
      await setProcessingState(document.id, "failed", "任务入队失败，请重试");
      throw error;
    }
    return reply.code(202).send({ status: "queued", documentId: document.id });
  });

  app.post<{ Params: { id: string } }>("/api/admin/documents/:id/embed", async (request, reply) => {
    const document = await getDocumentSummary(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    if (await queue.hasDocumentJob(document)) return reply.code(409).send({ error: "document already has a processing job" });
    if (document.processingStatus === "duplicate") return reply.code(409).send({ error: "重复文档不单独向量化，内容由主文档提供" });
    if (document.processingStatus !== "chunked" || !document.chunkCount) return reply.code(409).send({ error: "请先完成文档清洗与切片" });
    try {
      const provider = selectEmbeddingProvider(await listModelProviders());
      if (!process.env[provider.credentialEnv]?.trim()) throw new Error(`请在 API 和 Worker 环境配置 ${provider.credentialEnv}`);
    } catch (cause) {
      return reply.code(409).send({ error: cause instanceof Error ? cause.message : "Embedding configuration is invalid" });
    }
    await setEmbeddingState(document.id, "queued");
    try {
      await queue.enqueueDocument("embed-document", document.id);
    } catch (error) {
      await setEmbeddingState(document.id, "failed", "任务入队失败，请重试");
      throw error;
    }
    return reply.code(202).send({ status: "queued", documentId: document.id });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/documents/:id", async (request, reply) => {
    const document = await getDocumentSummary(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    if (await queue.hasDocumentJob(document)) return reply.code(409).send({ error: "document already has a processing job" });
    const deleted = await deleteDocument(document.id);
    if (!deleted) return reply.code(404).send({ error: "document not found" });
    // 删除的是主文档时，接替的重复文档已置为待处理，需要重新切片和向量化。
    if (deleted.promotedId) {
      try {
        await queue.enqueueDocument("reprocess-document", deleted.promotedId);
      } catch (error) {
        await setProcessingState(deleted.promotedId, "failed", "接替主文档后重新处理入队失败，请手动重新处理");
        request.log.error(error, "Failed to enqueue promoted duplicate document");
      }
    }
    return reply.code(204).send();
  });
};
