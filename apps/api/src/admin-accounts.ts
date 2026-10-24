import type { FastifyInstance } from "fastify";
import { AdminAccountError } from "@nyz-rag/processing";
import type { CreateAdminRequest, SaveAdminRoleRequest, UpdateAdminRequest, UpdateAdminRoleRequest } from "@nyz-rag/types";
import { superAdminOnly, type AdminRepository } from "./admin-auth.js";
import { hashPassword } from "./passwords.js";

const ACCOUNT_ERRORS: Record<AdminAccountError["reason"], [number, string]> = {
  "super-admin-disable": [403, "超级管理员账号不可停用"],
  "super-admin-role": [400, "超级管理员拥有全部权限，不能分配角色"],
  "role-missing": [400, "角色不存在"],
  "role-in-use": [409, "仍有管理员使用该角色，请先为他们更换角色"],
  "role-name-taken": [409, "角色名称已存在"],
};

/** 把账号与角色的业务错误转为带状态码的错误，由 common.ts 的错误处理返回原因。 */
function accountError(error: unknown): never {
  if (!(error instanceof AdminAccountError)) throw error;
  const [statusCode, message] = ACCOUNT_ERRORS[error.reason];
  throw Object.assign(new Error(message), { statusCode });
}

/** 超级管理员专属路由：管理员账号（创建、停用/启用、分配角色）与角色（增删改、停用/启用）。 */
export async function adminAccountRoutes(app: FastifyInstance, { admins }: { admins: AdminRepository }): Promise<void> {
  app.get("/api/admin/admins", superAdminOnly, async () => admins.listAdminAccounts());

  app.post<{ Body: CreateAdminRequest }>("/api/admin/admins", superAdminOnly, async (request, reply) => {
    const { email, nickname, password, roleId } = request.body;
    const normalized = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const account = await admins.createAdminAccount({ email: normalized, nickname: nickname.trim(), passwordHash, isSuper: false, roleId }).catch(accountError);
    if (!account) return reply.code(409).send({ error: "该邮箱已被其他管理员账号使用" });
    return reply.code(201).send(account);
  });

  app.patch<{ Params: { id: string }; Body: UpdateAdminRequest }>("/api/admin/admins/:id", superAdminOnly, async (request, reply) => {
    const updated = await admins.updateAdminAccount(request.params.id, request.body).catch(accountError);
    if (!updated) return reply.code(404).send({ error: "管理员账号不存在" });
    return updated;
  });

  app.get("/api/admin/roles", superAdminOnly, async () => admins.listAdminRoles());

  app.post<{ Body: SaveAdminRoleRequest }>("/api/admin/roles", superAdminOnly, async (request, reply) => {
    const { name, description, permissions } = request.body;
    const role = await admins.createAdminRole({ name: name.trim(), description: description.trim(), permissions }).catch(accountError);
    return reply.code(201).send(role);
  });

  app.patch<{ Params: { id: string }; Body: UpdateAdminRoleRequest }>("/api/admin/roles/:id", superAdminOnly, async (request, reply) => {
    const { name, description, ...rest } = request.body;
    const updated = await admins.updateAdminRole(request.params.id, {
      ...rest,
      ...(name !== undefined && { name: name.trim() }),
      ...(description !== undefined && { description: description.trim() }),
    }).catch(accountError);
    if (!updated) return reply.code(404).send({ error: "角色不存在" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/admin/roles/:id", superAdminOnly, async (request, reply) => {
    if (!await admins.deleteAdminRole(request.params.id).catch(accountError)) return reply.code(404).send({ error: "角色不存在" });
    return reply.code(204).send();
  });
}
