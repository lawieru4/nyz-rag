// 管理端权限码的运行时清单（@nyz-rag/types 只含类型，生产环境的 API 不能从中导入值）。
import type { AdminPermission } from "@nyz-rag/types";

/** 全部管理端权限，顺序即界面与接口返回的顺序。 */
export const ADMIN_PERMISSIONS = [
  "sources:view", "sources:manage",
  "documents:view", "documents:manage",
  "knowledge-bases:view", "knowledge-bases:manage",
  "chat-logs:view",
  "users:view", "users:manage",
  "models:view", "models:manage",
] as const satisfies readonly AdminPermission[];

// 新增 AdminPermission 而漏改上面的清单时，这里类型检查失败。
type MissingPermission = Exclude<AdminPermission, (typeof ADMIN_PERMISSIONS)[number]>;
export const ADMIN_PERMISSIONS_COMPLETE: [MissingPermission] extends [never] ? true : never = true;

export function isAdminPermission(value: string): value is AdminPermission {
  return (ADMIN_PERMISSIONS as readonly string[]).includes(value);
}

/** 去掉未知项与重复项，「管理」自动包含同模块的「查看」，按清单顺序返回。 */
export function normalizeAdminPermissions(values: readonly string[]): AdminPermission[] {
  const granted = new Set(values.filter(isAdminPermission));
  for (const permission of [...granted]) {
    if (permission.endsWith(":manage")) granted.add(permission.replace(/:manage$/, ":view") as AdminPermission);
  }
  return ADMIN_PERMISSIONS.filter((permission) => granted.has(permission));
}
