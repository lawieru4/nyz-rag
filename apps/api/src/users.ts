import type { FastifyPluginAsync } from "fastify";
import { listUsers, setUserDisabled } from "@nyz-rag/processing";
import type { AdminUserListResponse, UpdateUserRequest } from "@nyz-rag/types";
import { pageParams } from "./common.js";

export const userRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { query?: string; page?: string; pageSize?: string } }>("/api/admin/users", async (request): Promise<AdminUserListResponse> => {
    const { query = "", page = "1", pageSize = "20" } = request.query;
    return listUsers({ query, ...pageParams(page, pageSize) });
  });

  // 停用后该账号的登录会话立即失效、不能再登录；其会话与问答记录保留。
  app.patch<{ Params: { id: string }; Body: UpdateUserRequest }>("/api/admin/users/:id", async (request, reply) => {
    const user = await setUserDisabled(request.params.id, request.body.disabled);
    if (!user) return reply.code(404).send({ error: "user not found" });
    return user;
  });
};
