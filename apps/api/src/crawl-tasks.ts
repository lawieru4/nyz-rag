import type { FastifyPluginAsync } from "fastify";
import { createTask, getSource, updateTask } from "@nyz-rag/processing";
import type { DocumentQueue } from "./queue.js";
import { requires } from "./admin-auth.js";

export const crawlTaskRoutes: FastifyPluginAsync<{ queue: DocumentQueue }> = async (app, { queue }) => {
  app.post<{ Params: { id: string } }>("/api/admin/sources/:id/sync", requires("sources:manage"), async (request, reply) => {
    const source = await getSource(request.params.id);
    if (!source) return reply.code(404).send({ error: "source not found" });
    if (source.status !== "运行中") return reply.code(409).send({ error: "source is paused" });
    if (await queue.hasSourceJob(source.id)) return reply.code(409).send({ error: "source already has a sync job" });
    const task = await createTask(source);
    try {
      await queue.enqueueSource(source.id, task.id);
    } catch (error) {
      await updateTask(task.id, { status: "失败", error: "任务入队失败，请重试" });
      throw error;
    }
    return task;
  });
};
