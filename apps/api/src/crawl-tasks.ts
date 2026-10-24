import type { FastifyPluginAsync } from "fastify";
import { createTask, getSource } from "@nyz-rag/processing";
import { requires } from "./admin-auth.js";

export const crawlTaskRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { id: string } }>("/api/admin/sources/:id/sync", requires("sources:manage"), async (request, reply) => {
    const source = await getSource(request.params.id);
    if (!source) return reply.code(404).send({ error: "source not found" });
    if (source.status !== "运行中") return reply.code(409).send({ error: "source is paused" });
    // 任务与执行它的后台操作同一事务写入，由 Worker 投递；同一来源只能有一个等待中或运行中的任务。
    const task = await createTask(source);
    if (!task) return reply.code(409).send({ error: "source already has a sync job" });
    return task;
  });
};
