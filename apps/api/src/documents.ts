import type { FastifyPluginAsync } from "fastify";
import {
  deleteDocument, DocumentBusyError, getDocument, getDocumentDetail, getDocumentSummary, getModelSelection, hasProviderCredential, listDocuments,
  requestDocumentOperation, requireEmbeddingModel,
} from "@nyz-rag/processing";
import type { DocumentListResponse } from "@nyz-rag/types";
import { pageParams } from "./common.js";
import { requires } from "./admin-auth.js";

const BUSY = { error: "document already has a processing job" };

// 重新处理、向量化与删除后接替的重新处理都在同一事务内写入文档状态与后台操作，由 Worker 投递执行；API 不访问队列。
// 文档已有活动操作或所属来源正在同步时返回 409。
export const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: { id: string } }>("/api/documents/:id", async (request, reply) => {
    const document = await getDocumentDetail(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    return document;
  });

  app.get<{ Querystring: { query?: string; sourceId?: string; status?: string; page?: string; pageSize?: string } }>("/api/admin/documents", requires("documents:view"), async (request): Promise<DocumentListResponse> => {
    const { query = "", sourceId, status, page = "1", pageSize = "20" } = request.query;
    return listDocuments({ query, sourceId, status, ...pageParams(page, pageSize) });
  });

  app.get<{ Params: { id: string } }>("/api/admin/documents/:id", requires("documents:view"), async (request, reply) => {
    const document = await getDocument(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    return document;
  });

  app.post<{ Params: { id: string } }>("/api/admin/documents/:id/reprocess", requires("documents:manage"), async (request, reply) => {
    const result = await requestDocumentOperation(request.params.id, "reprocess-document");
    if (result === "not-found") return reply.code(404).send({ error: "document not found" });
    if (result === "busy") return reply.code(409).send(BUSY);
    return reply.code(202).send({ status: "queued", documentId: request.params.id });
  });

  app.post<{ Params: { id: string } }>("/api/admin/documents/:id/embed", requires("documents:manage"), async (request, reply) => {
    const document = await getDocumentSummary(request.params.id);
    if (!document) return reply.code(404).send({ error: "document not found" });
    if (document.processingStatus === "duplicate") return reply.code(409).send({ error: "重复文档不单独向量化，内容由主文档提供" });
    if (document.processingStatus !== "chunked" || !document.chunkCount) return reply.code(409).send({ error: "请先完成文档清洗与切片" });
    try {
      const { provider } = requireEmbeddingModel(await getModelSelection("embedding"));
      if (!hasProviderCredential(provider)) throw new Error("Embedding 模型所用供应商的密钥不可用，请在模型配置中检查 API 密钥或密钥环境变量");
    } catch (cause) {
      return reply.code(409).send({ error: cause instanceof Error ? cause.message : "Embedding configuration is invalid" });
    }
    const result = await requestDocumentOperation(document.id, "embed-document");
    if (result === "not-found") return reply.code(404).send({ error: "document not found" });
    if (result === "busy") return reply.code(409).send(BUSY);
    return reply.code(202).send({ status: "queued", documentId: document.id });
  });

  app.delete<{ Params: { id: string } }>("/api/admin/documents/:id", requires("documents:manage"), async (request, reply) => {
    let deleted;
    try {
      // 删除的是主文档时，接替的重复文档在同一事务内置为待处理并建立重新处理操作。
      deleted = await deleteDocument(request.params.id);
    } catch (error) {
      if (error instanceof DocumentBusyError) return reply.code(409).send(BUSY);
      throw error;
    }
    if (!deleted) return reply.code(404).send({ error: "document not found" });
    return reply.code(204).send();
  });
};
