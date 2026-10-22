import { randomUUID } from "node:crypto";
import type { UserCredentials } from "@nyz-rag/processing";
import type { AdminAuthConfig } from "../src/admin-auth.js";
import type { AuthStore } from "../src/auth-store.js";
import type { MailMessage, Mailer } from "../src/mailer.js";
import type { UserAuthConfig, UserRepository } from "../src/user-auth.js";

export const adminAuth: AdminAuthConfig = {
  username: "admin", password: "test-only-password-not-for-deployment",
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
