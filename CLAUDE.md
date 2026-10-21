# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

NYZ 文章问答（RAG）系统，pnpm workspace monorepo（`apps/*`、`packages/*`）。项目文档为中文；模块进度见 `docs/module-status.md`，目标架构见 `docs/rag-system-architecture.md`（该方案中的 NestJS/Prisma/Element Plus 等尚未采用，以现有代码为准）。

## 常用命令

```sh
pnpm install
pnpm dev                 # 先构建 processing，再并行启动 api / web / worker（不含 admin）
pnpm --filter @nyz-rag/admin dev
pnpm build               # pnpm -r build
pnpm typecheck           # 先构建 processing，再 pnpm -r typecheck
pnpm --filter @nyz-rag/<api|web|admin|worker|types|processing> dev|build|typecheck
```

- 测试只有 `packages/processing`（Node 内置 test runner + tsx）：`pnpm --filter @nyz-rag/processing test`。
- 单个测试文件：`pnpm --filter @nyz-rag/processing exec tsx --test test/embedding.test.ts`；按名称过滤加 `--test-name-pattern "<名称>"`。
- 集成测试 `test/pipeline.test.ts` 默认跳过；设置 `NYZ_INTEGRATION_TEST=1` 并提供 `DATABASE_URL`、`REDIS_URL` 启用。它用 tsx 直接拉起 API 和 Worker 源码，使用临时 PostgreSQL schema（连接串 `options=-c search_path=<schema>,public`，结束后删除）、唯一队列名和本地模拟 Embedding 服务。
- 数据库（Drizzle）：修改 `packages/processing/src/schema.ts` 后运行 `pnpm db:generate` 生成迁移（会去掉外键里写死的 `"public".`，使表可建在任意 schema）；`pnpm db:migrate` 手动执行迁移（API/Worker 启动时也会自动执行）；`pnpm db:import-snapshot [路径]` 把旧 JSON 快照和 `document_vectors` 导入新表，可重复执行。
- 没有配置 lint。`turbo.json` 存在但根脚本未使用 Turborepo。
- `@nyz-rag/processing` 通过 `dist/` 导出：单独启动/类型检查 API 或 Worker 前须先 `pnpm --filter @nyz-rag/processing build`，修改 processing 后也要重新构建。`@nyz-rag/types` 直接导出 `src/index.ts`，无需构建。
- 容器方式：`docker compose up -d --build --wait`（只启动 api/worker/web/admin）。不要同时运行本机 Worker 和容器 Worker。

## 架构

- `apps/api`：Fastify，几乎所有路由都在 `src/index.ts`。用户端接口 `/api/chat`、`/api/search`、`/api/messages/:id/feedback`；管理端接口在 `/api/admin/*`（sources、documents、knowledge-bases、model-providers、chat-logs），无认证。API 只负责改元数据和入队，不做采集/切片/向量化。
- `apps/worker`：BullMQ 消费者（`src/index.ts`，concurrency 1），处理三种 job：
  - `sync-source`：网页采集（robots.txt 检查、同源同路径链接、页数/间隔/超时由 `CRAWL_*` 环境变量控制）→ 正文提取 → `processDocument` 切片（800 字符窗口、120 重叠）→ 自动向量化。
  - `reprocess-document`：重新清洗切片并清除旧向量，再自动向量化。
  - `embed-document`：对已切片文档向量化（手动重试入口）。
  - 文档级 job 使用 `jobId: document-<id>`，API 据此及 active 的 `sync-source` 判断重复任务并返回 409。
- `packages/processing`：API 与 Worker 共享的运行时逻辑。
  - `schema.ts` / `db.ts`：Drizzle ORM（`node-postgres` 驱动，`casing: "snake_case"`）。`db.ts` 提供连接池（`DATABASE_URL` 必填）、`getDb()`、`withTransaction`、`migrate()`；迁移由 drizzle-kit 生成到 `migrations/`，运行时用 Drizzle migrator 执行，外加咨询锁串行，迁移记录表 `__drizzle_migrations` 放在当前 schema。不要手改已执行的迁移文件。
  - Drizzle 在单表查询里渲染列名不带表名：`sql` 模板中的相关子查询引用外层列时须用 `repository.ts` 的 `outer()` 显式限定（查询构建器生成的子查询不受影响）。
  - `repository.ts`：按实体的数据访问函数（数据源、任务、文档/切片、知识库、模型供应商、问答记录），负责数据库行与 `@nyz-rag/types` 结构的映射。需要多步一致性的操作接收事务内的执行器（`Executor`）。向量存在 `document_chunks.embedding`（pgvector，不限维度），切片和向量随文档级联删除。
  - 向量化并发约定：模型调用放在事务外；`documents.processing_version` 在每次重新切片时加一，向量回写前用 `SELECT ... FOR UPDATE` 比对版本，不一致则失败（参见 worker 的 `embedDocument`）。
  - `embedding.ts`：OpenAI 兼容 `/embeddings`，32 条一批。`selectEmbeddingProvider` 选唯一“启用 + 默认 + 有 embeddingModel”的 provider（数据库唯一索引保证最多一个默认）；provider 记录只保存密钥的**环境变量名**，运行时从 `process.env` 读取，密钥值不入库。
- `packages/types`：前后端共享的接口类型（`DocumentSummary` 为列表项、`DocumentRecord` 为含正文和切片的详情、`KnowledgeOverview` 等），以 `@nyz-rag/types` 引用。新增/修改接口时先改这里。
- `apps/web`、`apps/admin`：Vue 3 + Vite，各自基本是单个 `src/App.vue`。通过 `VITE_API_URL` 访问 API；Docker 构建中 `VITE_API_URL` 为空，由 Nginx 将同源 `/api/` 代理到 api:3000。
- 当前问答 `/api/chat` 仍是关键词匹配 + 片段拼接，尚未使用向量检索、Rerank 或 LLM。部分状态值是中文字面量（如任务状态 `等待中`/`运行中`/`已完成`/`失败`、来源类型 `网页站点`），修改时保持一致。

## 环境与基础设施

- API、Worker 和两个 Vite 应用都读取根目录 `.env`（gitignored，模板为 `.env.example`；默认端口 API 3001、web 5175、admin 5176）。只有 `VITE_` 前缀变量会暴露给浏览器，不要给密钥加此前缀。
- 本地复用共享的 PostgreSQL 18/pgvector（`localhost:5432`）和 Redis 8（`localhost:6379`），只使用专用 `nyzrag` 数据库/账号；API 与 Worker 必须设置相同的 `DOCUMENT_QUEUE_NAME=nyz-rag-document-processing`。不要改动或停止 booth-ai 等共享服务，禁止对共享 Redis 执行 `FLUSHALL`/`FLUSHDB`。`vector` 扩展需由管理员为非超级用户的应用账号预先创建。
- 可选独立基础设施：`docker compose --profile standalone up -d postgres redis`，端口 55433/56380。
- 容器启动器 `docker/start.mjs` 会把连接串中的 loopback 主机改写为 `host.docker.internal`。发布端口只绑定 127.0.0.1。
- `.nyz-data/`（gitignored）现在只存放旧版快照和 `scripts/nyz-articles/` 的样本数据，应用运行不再依赖它。

## 验证

修改后运行 `pnpm typecheck`、`pnpm build` 和 `pnpm --filter @nyz-rag/processing test`；涉及 API/队列/Worker 链路时在本地基础设施可用时加跑集成测试。
