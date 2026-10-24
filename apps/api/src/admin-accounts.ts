import type { FastifyInstance } from "fastify";
import type { AdminAccount, CreateAdminRequest } from "@nyz-rag/types";
import { superAdminOnly, type AdminRepository } from "./admin-auth.js";
import { hashPassword } from "./passwords.js";

/** 超级管理员专属路由：创建、列出、停用/启用普通管理员。 */
export async function adminAccountRoutes(app: FastifyInstance, { admins }: { admins: AdminRepository }): Promise<void> {
  app.get("/api/admin/admins", superAdminOnly, async () => admins.listAdminAccounts());

  app.post<{ Body: CreateAdminRequest }>("/api/admin/admins", superAdminOnly, async (request, reply) => {
    const { email, nickname, password } = request.body;
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const account = await admins.createAdminAccount({ email: normalized, nickname: nickname.trim(), passwordHash, isSuper: false });
    if (!account) return reply.code(409).send({ error: "该邮箱已被其他管理员账号使用" });
    return reply.code(201).send(account);
  });

  app.patch<{ Params: { id: string }; Body: { disabled: boolean } }>("/api/admin/admins/:id", superAdminOnly, async (request, reply) => {
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
