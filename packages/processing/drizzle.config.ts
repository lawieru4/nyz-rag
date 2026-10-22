import { defineConfig } from "drizzle-kit";

// 生成迁移不需要连接数据库；迁移在 API/Worker 启动时或 pnpm db:migrate 执行。
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
  casing: "snake_case",
});
