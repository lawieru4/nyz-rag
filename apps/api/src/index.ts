import { closeDatabase, closeModelAdmissionLimiter, migrate, modelAdmissionConfig, seedSuperAdmin } from "@nyz-rag/processing";
import { hashPassword } from "./passwords.js";
import { buildApp } from "./app.js";

modelAdmissionConfig();
const app = buildApp({ logger: true });
const port = Number(process.env.API_PORT ?? 3000);
app.addHook("onClose", closeDatabase);
app.addHook("onClose", closeModelAdmissionLimiter);
process.once("SIGINT", () => void app.close());
process.once("SIGTERM", () => void app.close());

try {
  await migrate();

  // 初始超级管理员种子：仅在没有任何管理员账号时创建。
  // ADMIN_PASSWORD 必须已配置（16–1024 字符）；不满足时跳过并记录警告。
  const adminPassword = process.env.ADMIN_PASSWORD ?? "";
  if (adminPassword.length >= 16 && adminPassword.length <= 1024) {
    const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").trim().toLowerCase();
    const nickname = (process.env.ADMIN_USERNAME ?? "admin").trim() || "admin";
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("ADMIN_EMAIL must be a valid email address");
    if (nickname.length > 100) throw new Error("ADMIN_USERNAME must contain at most 100 characters");
    const passwordHash = await hashPassword(adminPassword);
    const result = await seedSuperAdmin({ email, nickname, passwordHash });
    if (result.created) {
      app.log.info({ adminId: result.id, email }, "Super admin seeded");
    }
  } else if (adminPassword) {
    app.log.warn("ADMIN_PASSWORD is set but does not meet the 16–1024 character requirement; skipping seed");
  } else {
    app.log.info("ADMIN_PASSWORD not set; skipping super admin seed (set it to seed the initial account)");
  }

  await app.listen({ host: "0.0.0.0", port });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
  await app.close();
}
