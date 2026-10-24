import { randomUUID } from "node:crypto";
import type { AdminAccount, AdminRole } from "@nyz-rag/types";
import { ADMIN_PERMISSIONS, AdminAccountError, normalizeAdminPermissions, type AdminCredentials } from "@nyz-rag/processing";
import type { AdminAuthConfig, AdminRepository } from "../src/admin-auth.js";
import type { AuthStore } from "../src/auth-store.js";
import type { MailMessage, Mailer } from "../src/mailer.js";
import type { UserAuthConfig, UserRepository } from "../src/user-auth.js";
import type { UserCredentials } from "@nyz-rag/processing";
import { buildApp } from "../src/app.js";

export function buildTestApp(options: Parameters<typeof buildApp>[0] = {}) {
  return buildApp({ limiter: { async acquire() { return { async release() {} }; }, async close() {} }, ...options });
}

export const adminAuth: AdminAuthConfig = {
  legacyUsername: "admin",
  origins: ["http://localhost:5176"], secureCookie: false,
};
export const adminHeaders = { "x-nyz-admin": "1", origin: adminAuth.origins[0]! };

export const userAuth: UserAuthConfig = { origins: ["http://localhost:5175"], secureCookie: false };
export const userHeaders = { "x-nyz-client": "1" };

export function memoryAuthStore(now = Date.now): AuthStore {
  const data = new Map<string, { value: string; expires: number }>();
  const get = async (key: string) => {
    const entry = data.get(key);
    return entry && entry.expires > now() ? entry.value : null;
  };
  return {
    get,
    async set(key, value, ttl) { data.set(key, { value, expires: now() + ttl * 1000 }); },
    async delete(key) { data.delete(key); },
    async increment(key, ttl) {
      const value = Number(await get(key)) + 1;
      data.set(key, { value: String(value), expires: value === 1 ? now() + ttl * 1000 : data.get(key)!.expires });
      return value;
    },
    async close() {},
  };
}

/** 内存管理员账号的输入：角色名称与生效权限由角色表推导。 */
export type MemoryAdminInput = Omit<AdminCredentials, "roleId" | "roleName" | "permissions"> & { roleId?: string | null };
type MemoryRole = Omit<AdminRole, "adminCount">;

/** 内存管理员账号与角色库，行为与 processing 的数据库实现一致（角色停用即无权限、使用中的角色不能删除）。 */
export function memoryAdmins(initial: MemoryAdminInput[] = []) {
  const accounts = new Map<string, MemoryAdminInput>(initial.map((a) => [a.id, { ...a }]));
  const roles = new Map<string, MemoryRole>();

  function credentials(account: MemoryAdminInput): AdminCredentials {
    const role = account.roleId ? roles.get(account.roleId) : undefined;
    const permissions = account.isSuper ? [...ADMIN_PERMISSIONS] : role && !role.disabled ? normalizeAdminPermissions(role.permissions) : [];
    return { ...account, roleId: account.roleId ?? null, roleName: role?.name ?? null, permissions };
  }

  function toAccount(account: MemoryAdminInput): AdminAccount {
    const { passwordHash: _ph, sessionVersion: _sv, permissions: _p, ...rest } = credentials(account);
    return rest;
  }

  const toRole = (role: MemoryRole): AdminRole =>
    ({ ...role, adminCount: [...accounts.values()].filter((a) => a.roleId === role.id).length });

  const assertRoleExists = (roleId: string | null | undefined) => {
    if (roleId && !roles.has(roleId)) throw new AdminAccountError("role-missing");
  };
  const assertNameFree = (name: string, id?: string) => {
    if ([...roles.values()].some((role) => role.name === name && role.id !== id)) throw new AdminAccountError("role-name-taken");
  };

  const repository: AdminRepository & { _accounts: Map<string, MemoryAdminInput> } = {
    _accounts: accounts,
    async listAdminAccounts() { return [...accounts.values()].map(toAccount); },
    async createAdminAccount(input) {
      if ([...accounts.values()].some(a => a.email === input.email)) return null;
      assertRoleExists(input.roleId);
      const account: MemoryAdminInput = { ...input, id: randomUUID(), isSuper: input.isSuper ?? false, roleId: input.isSuper ? null : input.roleId ?? null, disabled: false, sessionVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      accounts.set(account.id, account);
      return toAccount(account);
    },
    async updateAdminAccount(id, input) {
      const account = accounts.get(id);
      if (!account) return null;
      if (account.isSuper && input.disabled) throw new AdminAccountError("super-admin-disable");
      if (account.isSuper && input.roleId) throw new AdminAccountError("super-admin-role");
      assertRoleExists(input.roleId);
      if (input.disabled !== undefined) {
        if (input.disabled && !account.disabled) account.sessionVersion++;
        account.disabled = input.disabled;
      }
      if (input.roleId !== undefined) account.roleId = input.roleId;
      return toAccount(account);
    },
    async getAdminCredentials(by) {
      const account = "id" in by
        ? accounts.get(by.id)
        : [...accounts.values()].find((a) => a.email === by.email);
      return account ? credentials(account) : null;
    },
    async updateAdminPassword(id, passwordHash) {
      const account = accounts.get(id);
      if (!account) return null;
      account.passwordHash = passwordHash;
      account.sessionVersion += 1;
      account.updatedAt = new Date().toISOString();
      return account.sessionVersion;
    },
    async updateAdminProfile(id, input) {
      // Check for email conflict
      const existing = [...accounts.values()].find((a) => a.email === input.email && a.id !== id);
      if (existing) return null;
      const account = accounts.get(id);
      if (!account) return null;
      account.email = input.email;
      account.nickname = input.nickname;
      account.updatedAt = new Date().toISOString();
      return toAccount(account);
    },
    async listAdminRoles() { return [...roles.values()].map(toRole); },
    async createAdminRole(input) {
      assertNameFree(input.name);
      const now = new Date().toISOString();
      const role: MemoryRole = { id: randomUUID(), name: input.name, description: input.description, permissions: normalizeAdminPermissions(input.permissions), disabled: false, createdAt: now, updatedAt: now };
      roles.set(role.id, role);
      return toRole(role);
    },
    async updateAdminRole(id, input) {
      const role = roles.get(id);
      if (!role) return null;
      if (input.name !== undefined) assertNameFree(input.name, id);
      Object.assign(role, {
        ...input,
        ...(input.permissions && { permissions: normalizeAdminPermissions(input.permissions) }),
        updatedAt: new Date().toISOString(),
      });
      return toRole(role);
    },
    async deleteAdminRole(id) {
      if ([...accounts.values()].some((a) => a.roleId === id)) throw new AdminAccountError("role-in-use");
      return roles.delete(id);
    },
  };

  return { accounts, roles, repository };
}

/** 创建一个有密码哈希的测试管理员凭据（同步，测试用固定哈希）。 */
export function makeAdminCredential(override: Partial<MemoryAdminInput> = {}): MemoryAdminInput {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    email: "admin@example.com",
    nickname: "admin",
    // scrypt hash of "test-only-password-not-for-deployment" — computed via hashPassword offline;
    // in tests we use a pre-stored real hash for speed or we accept the cost.
    // For unit tests we just store a sentinel and override verifyPassword via mock, but
    // here we use the real hash produced by hashPassword("test-only-password-not-for-deployment").
    // Since scrypt is expensive, tests that need actual password verification should use
    // hashPassword() in a beforeEach or pass in a known hash.
    passwordHash: "scrypt$32768$8$1$placeholder$placeholder",
    isSuper: true,
    sessionVersion: 0,
    disabled: false,
    createdAt: now,
    updatedAt: now,
    ...override,
  };
}

/** 内存账号库：记录访客数据的认领，便于断言登录时的归属转移。 */
export function memoryUsers() {
  const accounts = new Map<string, UserCredentials>();
  const claims: Array<{ visitorHash: string; userId: string }> = [];
  const repository: UserRepository = {
    async getUserCredentials(by) {
      const user = "id" in by ? accounts.get(by.id) : [...accounts.values()].find((item) => item.email === by.email);
      return user ? { ...user } : null;
    },
    async createUser({ email, passwordHash }) {
      if ([...accounts.values()].some((item) => item.email === email)) return null;
      const user: UserCredentials = { id: randomUUID(), email, passwordHash, sessionVersion: 0, disabled: false, createdAt: new Date().toISOString() };
      accounts.set(user.id, user);
      return { ...user };
    },
    async updateUserPassword(id, passwordHash) {
      const user = accounts.get(id);
      if (!user) return null;
      Object.assign(user, { passwordHash, sessionVersion: user.sessionVersion + 1 });
      return user.sessionVersion;
    },
    async recordUserLogin() {},
    async claimVisitorData(visitorHash, userId) { claims.push({ visitorHash, userId }); },
  };
  return { accounts, claims, repository };
}

export function memoryMailer(): Mailer & { sent: MailMessage[] } {
  const sent: MailMessage[] = [];
  return { sent, async send(message) { sent.push(message); } };
}
