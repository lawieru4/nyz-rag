import type { AdminAuthConfig, AdminAuthStore } from "../src/admin-auth.js";

export const adminAuth: AdminAuthConfig = {
  username: "admin", password: "test-only-password-not-for-deployment",
  origins: ["http://localhost:5176"], secureCookie: false,
};
export const adminHeaders = { "x-nyz-admin": "1", origin: adminAuth.origins[0]! };

export function memoryAuthStore(now = Date.now): AdminAuthStore {
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
