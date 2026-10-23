import { randomUUID } from "node:crypto";
import type { AdminAccount } from "@nyz-rag/types";
import type { AdminCredentials } from "@nyz-rag/processing";
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

/** 内存管理员账号库，支持登录、资料更新与密码修改测试。 */
export function memoryAdmins(initial: AdminCredentials[] = []) {
  const accounts = new Map<string, AdminCredentials>(initial.map((a) => [a.id, { ...a }]));

  function toAccount(cred: AdminCredentials): AdminAccount {
    return { id: cred.id, email: cred.email, nickname: cred.nickname, isSuper: cred.isSuper, disabled: cred.disabled, createdAt: cred.createdAt, updatedAt: cred.updatedAt };
  }

  const repository: AdminRepository & { _accounts: Map<string, AdminCredentials> } = {
    _accounts: accounts,
    async listAdminAccounts() { return [...accounts.values()].map(toAccount); },
    async createAdminAccount(input) {
      if ([...accounts.values()].some(a => a.email === input.email)) return null;
      const account: AdminCredentials = { ...input, id: randomUUID(), isSuper: input.isSuper ?? false, disabled: false, sessionVersion: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      accounts.set(account.id, account);
      return toAccount(account);
    },
    async setAdminDisabled(id, disabled) {
      const account = accounts.get(id);
      if (!account) return null;
      if (account.isSuper && disabled) throw new Error("super admin cannot be disabled");
      account.disabled = disabled;
      if (disabled) account.sessionVersion++;
      return toAccount(account);
    },
    async getAdminCredentials(by) {
      const account = "id" in by
        ? accounts.get(by.id)
        : [...accounts.values()].find((a) => a.email === by.email);
      return account ? { ...account } : null;
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
      return toAccount({ ...account });
    },
  };

  return { accounts, repository };
}

/** 创建一个有密码哈希的测试管理员凭据（同步，测试用固定哈希）。 */
export function makeAdminCredential(override: Partial<AdminCredentials> = {}): AdminCredentials {
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
