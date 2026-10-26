import type { AdminAuditLogRecord, AdminAuditResult } from "@nyz-rag/types";

// 写操作按「方法 + 路由模式」给出中文名称；未列出的显示原始路由。
const WRITE_ACTIONS: Record<string, string> = {
  "POST /api/admin/auth/login": "登录",
  "POST /api/admin/auth/logout": "退出登录",
  "PATCH /api/admin/auth/profile": "修改个人资料",
  "POST /api/admin/auth/password": "修改密码",
  "POST /api/admin/admins": "添加管理员",
  "PATCH /api/admin/admins/:id": "修改管理员（停用、启用或更换角色）",
  "POST /api/admin/roles": "新建角色",
  "PATCH /api/admin/roles/:id": "编辑角色",
  "DELETE /api/admin/roles/:id": "删除角色",
  "PUT /api/admin/settings/article-token": "设置文章 token",
  "DELETE /api/admin/settings/article-token": "清除文章 token",
  "POST /api/admin/sources": "新建数据源",
  "PATCH /api/admin/sources/:id": "修改数据源（启停或同步频率）",
  "POST /api/admin/sources/:id/sync": "同步数据源",
  "POST /api/admin/documents/:id/reprocess": "重新处理文档",
  "POST /api/admin/documents/:id/embed": "向量化文档",
  "DELETE /api/admin/documents/:id": "删除文档",
  "POST /api/admin/knowledge-bases": "新建知识库",
  "PATCH /api/admin/knowledge-bases/:id": "编辑知识库",
  "PATCH /api/admin/users/:id": "停用或启用用户",
  "POST /api/admin/model-providers": "新建模型供应商",
  "PATCH /api/admin/model-providers/:id": "编辑模型供应商",
  "DELETE /api/admin/model-providers/:id": "删除模型供应商",
  "POST /api/admin/model-providers/models": "测试模型连接",
  "PUT /api/admin/model-settings/:capability": "设置业务模型",
  "DELETE /api/admin/model-settings/:capability": "清除业务模型",
};

// 读取只在被拒绝时记录，按路由的模块显示「查看 …」。
const MODULES: Record<string, string> = {
  auth: "会话", admins: "管理员", roles: "角色", knowledge: "知识概览", settings: "文章 token", sources: "数据源",
  documents: "文档", "knowledge-bases": "知识库", "chat-logs": "问答记录", "audit-logs": "操作日志", users: "用户",
  "model-providers": "模型供应商", "model-settings": "业务模型",
};

export function auditActionLabel(log: Pick<AdminAuditLogRecord, "method" | "route">): string {
  const action = WRITE_ACTIONS[`${log.method} ${log.route}`];
  if (action) return action;
  const module = MODULES[log.route.split("/")[3] ?? ""];
  return ["GET", "HEAD"].includes(log.method) && module ? `查看${module}` : `${log.method} ${log.route}`;
}

export const AUDIT_RESULTS: Array<{ value: AdminAuditResult; label: string }> = [
  { value: "success", label: "成功" },
  { value: "denied", label: "拒绝" },
  { value: "failed", label: "失败" },
];

export const auditResultLabel = (result: AdminAuditResult) => AUDIT_RESULTS.find((item) => item.value === result)!.label;
export const auditResultVariant = (result: AdminAuditResult) => result === "success" ? "success" : result === "denied" ? "warning" : "danger";

export const auditOperator = (log: Pick<AdminAuditLogRecord, "adminId" | "adminNickname">) =>
  log.adminId ? log.adminNickname ?? "已删除的管理员" : "未登录";
