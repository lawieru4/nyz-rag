import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AdminAccount, CreateAdminRequest } from "@nyz-rag/types";
import { getAdminSession, type AdminRepository } from "./admin-auth.js";
import { hashPassword } from "./passwords.js";

/** 超级管理员专属路由：创建、列出、停用/启用普通管理员。 */
export async function adminAccountRoutes(app: FastifyInstance, { admins }: { admins: AdminRepository }): Promise<void> {
  // 所有路由都已通过 configureAdminAuth 的 onRequest 钩子验证会话；此处只需追加 isSuper 检查。
  function assertSuper(request: FastifyRequest, reply: FastifyReply): boolean {
    const session = getAdminSession(request);
    if (!session?.admin.isSuper) {
      reply.code(403).send({ error: "仅超级管理员可执行此操作" });
      return false;
    }
    return true;
  }

  app.get("/api/admin/admins", async (request, reply) => {
    if (!assertSuper(request, reply)) return;
    return admins.listAdminAccounts();
  });

  app.post<{ Body: CreateAdminRequest }>("/api/admin/admins", async (request, reply) => {
    if (!assertSuper(request, reply)) return;
    const { email, nickname, password } = request.body;
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const account = await admins.createAdminAccount({ email: normalized, nickname: nickname.trim(), passwordHash, isSuper: false });
    if (!account) return reply.code(409).send({ error: "该邮箱已被其他管理员账号使用" });
    return reply.code(201).send(account);
  });

  app.patch<{ Params: { id: string }; Body: { disabled: boolean } }>("/api/admin/admins/:id", async (request, reply) => {
    if (!assertSuper(request, reply)) return;
    let updated: AdminAccount | null;
    try {
      updated = await admins.setAdminDisabled(request.params.id, request.body.disabled);
    } catch (error) {
      if (error instanceof Error && error.message === "super admin cannot be disabled") {
        return reply.code(403).send({ error: "超级管理员账号不可停用" });
      }
      throw error;
    }
    if (!updated) return reply.code(404).send({ error: "管理员账号不存在" });
    return updated;
  });
}
