import type { AdminPermission, AdminPermissionModule } from "@nyz-rag/types";

/** 角色可授予的权限：模块 × 查看/管理（管理包含查看），顺序与服务端 ADMIN_PERMISSIONS 一致。 */
export const PERMISSION_MODULES = [
  { module: "sources", label: "数据源", view: "数据源、同步任务与 token 状态", manage: "新建、同步、暂停数据源，设置文章 token" },
  { module: "documents", label: "文档管理", view: "文档、正文与切片", manage: "重新处理、向量化、删除文档" },
  { module: "knowledge-bases", label: "知识库", view: "检索参数", manage: "新建与编辑知识库" },
  { module: "chat-logs", label: "问答记录", view: "问答记录与召回片段" },
  { module: "users", label: "用户管理", view: "用户账号", manage: "停用与启用用户" },
  { module: "models", label: "模型配置", view: "供应商与业务模型", manage: "修改供应商、API Key 与业务模型" },
] as const satisfies ReadonlyArray<{ module: AdminPermissionModule; label: string; view: string; manage?: string }>;

// 新增 AdminPermissionModule 而漏改上面的清单时，这里类型检查失败。
type MissingModule = Exclude<AdminPermissionModule, (typeof PERMISSION_MODULES)[number]["module"]>;
export const PERMISSION_MODULES_COMPLETE: [MissingModule] extends [never] ? true : never = true;

export type PermissionModule = (typeof PERMISSION_MODULES)[number];
export const viewPermission = (module: AdminPermissionModule) => `${module}:view` as AdminPermission;
export const managePermission = (module: AdminPermissionModule) => `${module}:manage` as AdminPermission;
export const hasManage = (item: PermissionModule): item is Extract<PermissionModule, { manage: string }> => "manage" in item;

/** 权限的中文名，如「数据源 · 管理」。 */
export function permissionLabel(permission: AdminPermission): string {
  const [module, action] = permission.split(":");
  const label = PERMISSION_MODULES.find((item) => item.module === module)?.label ?? module;
  return `${label} · ${action === "manage" ? "管理" : "查看"}`;
}
