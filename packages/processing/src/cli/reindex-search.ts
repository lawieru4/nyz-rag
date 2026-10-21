// 用法：pnpm db:reindex-search（读取根目录 .env 中的 DATABASE_URL）
// 按当前规则重新生成全部切片的关键词检索词项，不改变切片和向量。词项规则（search-terms.ts）变化后执行，可重复执行；
// 升级前已切片、词项为空的数据由 Worker 启动时自动补齐。
import { closeDatabase } from "../db.js";
import { reindexChunkSearchTerms } from "../repository.js";

const BATCH_SIZE = 500;

try {
  let cursor = "";
  let batches = 0;
  for (;;) {
    const last = await reindexChunkSearchTerms(cursor, BATCH_SIZE);
    if (!last) break;
    cursor = last;
    batches += 1;
    if (batches % 20 === 0) console.info(`已处理约 ${batches * BATCH_SIZE} 个切片`);
  }
  console.info(`检索词项重建完成（${batches} 批）`);
} finally {
  await closeDatabase();
}
