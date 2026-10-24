import type { FastifyInstance } from "fastify";
import type { AdminAuditLogListResponse } from "@nyz-rag/types";
import { requires, type AdminRepository } from "./admin-auth.js";
import { pageParams } from "./common.js";

/** 管理端操作日志（由 admin-auth.ts 的 onResponse 钩子写入），只读，需「操作日志 · 查看」权限。 */
export async function auditLogRoutes(app: FastifyInstance, { admins }: { admins: AdminRepository }): Promise<void> {
  app.get<{ Querystring: { query?: string; result?: string; page?: string; pageSize?: string } }>(
    "/api/admin/audit-logs", requires("audit-logs:view"),
    async (request): Promise<AdminAuditLogListResponse> => {
      const { query = "", result, page = "1", pageSize = "20" } = request.query;
      return admins.listAdminAuditLogs({ query, result, ...pageParams(page, pageSize) });
    },
  );
}
