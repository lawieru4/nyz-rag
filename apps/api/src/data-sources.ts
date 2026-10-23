import type { FastifyPluginAsync } from "fastify";
import { createSource, updateSourceStatus } from "@nyz-rag/processing";
import type { CreateSourceRequest, UpdateSourceStatusRequest } from "@nyz-rag/types";

export const dataSourceRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: CreateSourceRequest }>("/api/admin/sources", async (request, reply) => {
    const { name, url, kind, frequency } = request.body;
    let parsed: URL;
    try { parsed = new URL(url.trim()); } catch { return reply.code(400).send({ error: "url must be a valid http(s) URL" }); }
    if (!["http:", "https:"].includes(parsed.protocol)) return reply.code(400).send({ error: "url must be a valid http(s) URL" });
    // Source URLs are public metadata; credentials belong only in the worker environment.
    if (parsed.searchParams.has("token")) return reply.code(400).send({ error: "文章 API 地址不能包含 token，请在 Worker 环境变量 NYZ_ARTICLE_TOKEN 中配置" });
    return createSource({ name: name.trim(), url: url.trim(), kind, frequency: frequency ?? "" });
  });

  app.patch<{ Params: { id: string }; Body: UpdateSourceStatusRequest }>("/api/admin/sources/:id", async (request, reply) => {
    const updated = await updateSourceStatus(request.params.id, request.body.status);
    if (!updated) return reply.code(404).send({ error: "source not found" });
    return updated;
  });
};
