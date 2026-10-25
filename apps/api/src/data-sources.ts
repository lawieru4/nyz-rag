import type { FastifyPluginAsync } from "fastify";
import { createSource, updateSource } from "@nyz-rag/processing";
import type { CreateSourceRequest, UpdateSourceRequest } from "@nyz-rag/types";
import { requires } from "./admin-auth.js";

export const dataSourceRoutes: FastifyPluginAsync = async (app) => {
  // Worker 会把全局文章 token 发往来源地址，新建来源须有「数据源·管理」权限。
  app.post<{ Body: CreateSourceRequest }>("/api/admin/sources", requires("sources:manage"), async (request, reply) => {
    const { name, url, kind, frequency } = request.body;
    let parsed: URL;
    try { parsed = new URL(url.trim()); } catch { return reply.code(400).send({ error: "url must be a valid http(s) URL" }); }
    if (!["http:", "https:"].includes(parsed.protocol)) return reply.code(400).send({ error: "url must be a valid http(s) URL" });
    // Source URLs are public metadata; credentials belong only in the worker environment.
    if (parsed.searchParams.has("token")) return reply.code(400).send({ error: "文章 API 地址不能包含 token，请在数据源页面的接口 Token 中配置" });
    return createSource({ name: name.trim(), url: url.trim(), kind, frequency: frequency ?? "" });
  });

  // 修改频率后按新周期判断到期（仍从最近同步或任务创建时间起算），不立即触发同步。
  app.patch<{ Params: { id: string }; Body: UpdateSourceRequest }>("/api/admin/sources/:id", requires("sources:manage"), async (request, reply) => {
    const { status, frequency } = request.body;
    const updated = await updateSource(request.params.id, { status, frequency });
    if (!updated) return reply.code(404).send({ error: "source not found" });
    return updated;
  });
};
