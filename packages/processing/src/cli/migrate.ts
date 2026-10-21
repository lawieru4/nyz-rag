// 用法：pnpm db:migrate（读取根目录 .env 中的 DATABASE_URL）
import { closeDatabase, migrate } from "../db.js";

try {
  await migrate();
  console.info("数据库迁移完成");
} finally {
  await closeDatabase();
}
