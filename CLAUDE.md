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
pnpm --filter @nyz-rag/<api|web|admin|worker|types|processing|api-client> dev|build|typecheck
```

- 测试均使用 Node 内置 test runner + tsx：`pnpm --filter @nyz-rag/processing test`、`pnpm --filter @nyz-rag/api test`（契约测试，用 Fastify inject 和注入的假队列，不需要数据库/Redis）、`pnpm --filter @nyz-rag/api-client test`。
- 单个测试文件：`pnpm --filter @nyz-rag/processing exec tsx --test test/article.test.ts`（解析、切片、文章接口与增量同步）、`test/retrieval.test.ts`（检索词项、RRF/Rerank、Prompt 组装、Chat 流解析）或 `test/embedding.test.ts`；按名称过滤加 `--test-name-pattern "<名称>"`。
- 集成测试 `test/pipeline.test.ts` 默认跳过；设置 `NYZ_INTEGRATION_TEST=1` 并提供 `DATABASE_URL`、`REDIS_URL` 启用。它用 tsx 直接拉起 API 和 Worker 源码，使用临时 PostgreSQL schema（连接串 `options=-c search_path=<schema>,public`，结束后删除）、唯一队列名和本地模拟 Embedding 服务。
- 数据库（Drizzle）：修改 `packages/processing/src/schema.ts` 后运行 `pnpm db:generate` 生成迁移（会去掉外键里写死的 `"public".`，使表可建在任意 schema）；`pnpm db:migrate` 手动执行迁移（API/Worker 启动时也会自动执行）；`pnpm db:import-snapshot [路径]` 把旧 JSON 快照和 `document_vectors` 导入新表，可重复执行；`pnpm db:reindex-search` 按当前词项规则重建全部切片与文档元数据的关键词检索词项（修改 `search-terms.ts` 后执行）。
- 没有配置 lint。`turbo.json` 存在但根脚本未使用 Turborepo。
- `@nyz-rag/processing` 通过 `dist/` 导出：单独启动/类型检查 API 或 Worker 前须先 `pnpm --filter @nyz-rag/processing build`，修改 processing 后也要重新构建。`@nyz-rag/types` 直接导出 `src/index.ts`，无需构建。
- 容器方式：`docker compose up -d --build --wait`（只启动 api/worker/web/admin）。不要同时运行本机 Worker 和容器 Worker。

## 架构

- `apps/api`：Fastify，按领域拆为插件（`chat`、`search`、`documents`、`data-sources`、`crawl-tasks`、`knowledge-bases`、`model-providers`、`common`），`src/app.ts` 的 `buildApp({ queue })` 组装（测试注入假队列），`src/index.ts` 只做迁移与监听。
  - 请求/响应校验用 Fastify JSON Schema，集中在 `src/schemas.ts`，以 `"METHOD /path"` 为键由 `common.ts` 的 `onRoute` 钩子挂载；新增或修改路由必须同步此注册表（`test/app.test.ts` 校验路由与 schema 一一对应）。Ajv 关闭类型强制转换，参数 ID 必须是 UUID（公开文章接口 `GET /api/documents/:id` 除外，未知 ID 一律 404），请求体拒绝未知字段；响应 schema 只输出声明过的字段，给接口加字段时漏改 schema 会被静默丢弃。
  - `common.ts` 的错误处理钩子把所有错误统一为 `{ error: string }`：4xx 返回原因，其余记日志并返回 `Internal server error`。路由内直接 `reply.code(4xx).send({ error })`。
  - 队列访问只经过 `src/queue.ts`（`DocumentQueue`）：文档级 jobId `document-<id>`，来源同步 jobId `sync-<taskId>`，`hasDocumentJob` / `hasSourceJob` 做重复任务检测。
  - 问答（`src/chat.ts`）在请求内完成检索与生成（`answerQuestion`）：`retrieve`（关键词 + 切片向量 + 摘要召回三路，RRF 合并，知识库开启时 Rerank；两路向量召回共用一次查询 Embedding）→ `buildAnswerContext` → 流式调用默认供应商的 Chat 模型；未配置 Chat 模型、密钥缺失或调用失败时返回原文摘录（`answerMode: "extractive"`），向量检索/摘要召回/Rerank 失败只降级并记日志。检索参数取 `knowledgeBaseId` 指定或最近创建的知识库。用户端接口：单次问答 `/api/chat`；会话 `/api/chat/sessions`（列表/创建）、`/api/chat/sessions/:id/messages`、`DELETE /api/chat/sessions/:id`；流式问答 `POST /api/chat/sessions/:id/stream`（SSE，事件 `source`/`token`/`done`/`error`，`done` 的回答为准；`{ regenerate: messageId }` 只能重新生成最后一轮，被替换的消息标记 `superseded_at`，仍保留在问答记录中；客户端断开时中止模型调用且不保存）；以及 `/api/search`、`/api/messages/:id/feedback`。管理端接口在 `/api/admin/*`（sources、documents、knowledge-bases、model-providers、chat-logs、knowledge），由 `src/admin-auth.ts` 的 `onRequest` 钩子统一鉴权：单管理员账号（`ADMIN_USERNAME`/`ADMIN_PASSWORD`，未设密码时返回 503），登录 `/api/admin/auth/login`、`/session`、`/logout`；会话为 HttpOnly + SameSite=Strict Cookie（Path=/api/admin，8 小时），存于 Redis（键前缀 `<DOCUMENT_QUEUE_NAME>:admin-auth:`，凭据变更即全部失效），校验 `ADMIN_ORIGINS` 精确来源，非 GET/HEAD 须带 `X-NYZ-Admin: 1` 防 CSRF，登录按 IP 与全局限流。测试用 `buildApp({ adminAuth, authStore })` 注入配置和内存存储（`test/auth-helpers.ts`）。公开 `/api/knowledge` 只返回统计，完整概览在 `/api/admin/knowledge`。API 只负责改元数据和入队，不做采集/切片/向量化。
- `apps/worker`：BullMQ 消费者（`src/index.ts`，concurrency 1），处理三种 job：
  - `sync-source`：按来源类型分两条路径，入库后都在同一事务内由 `processDocument` 切片，再自动向量化。
    - `网页站点`：robots.txt 检查、同源同路径链接，页数/间隔/超时由 `CRAWL_*` 环境变量控制，正文提取保留换行。
    - `文章 API`：来源 `url` 为 nyzdata 文章列表接口，token 只读 Worker 的 `NYZ_ARTICLE_TOKEN`（API 拒绝带 token 的地址）。由 `syncArticles` 按 `updateTime` 增量同步，回填进度与失败文章存于 `data_sources.sync_state`。详情原样存入 `documents.raw_json`，`external_id` 为 articleKey。
  - `reprocess-document`：重新清洗切片并清除旧向量，再自动向量化。文章来源会用当前解析器从 `raw_json` 重新解析，不请求接口。
  - `embed-document`：对已切片文档向量化（手动重试入口）。
  - 文档级 job 使用 `jobId: document-<id>`，API 据此及 active 的 `sync-source` 判断重复任务并返回 409；同一来源已有等待/运行中的 `sync-source` 时再次同步也返回 409。
- `packages/processing`：API 与 Worker 共享的运行时逻辑。
  - `schema.ts` / `db.ts`：Drizzle ORM（`node-postgres` 驱动，`casing: "snake_case"`）。`db.ts` 提供连接池（`DATABASE_URL` 必填）、`getDb()`、`withTransaction`、`migrate()`；迁移由 drizzle-kit 生成到 `migrations/`，运行时用 Drizzle migrator 执行，外加咨询锁串行，迁移记录表 `__drizzle_migrations` 放在当前 schema。不要手改已执行的迁移文件。
  - Drizzle 在单表查询里渲染列名不带表名：`sql` 模板中的相关子查询引用外层列时须用 `repository.ts` 的 `outer()` 显式限定（查询构建器生成的子查询不受影响）。
  - `repository.ts`：按实体的数据访问函数（数据源、任务、文档/切片、知识库、模型供应商、问答记录），负责数据库行与 `@nyz-rag/types` 结构的映射。需要多步一致性的操作接收事务内的执行器（`Executor`）。向量存在 `document_chunks.embedding`（pgvector，不限维度），切片和向量随文档级联删除。
  - 文章级向量：`documents.summary_embedding` 存「标题 + 摘要」（`summaryEmbeddingInput`）的向量，与切片在同一次 Embedding 调用中生成、同一事务写入，模型与维度沿用 `documents.embedding_model` / `embedding_dimensions`（常用维度有 HNSW 部分索引）；没有摘要的文档（网页）为空，重新切片或重新向量化开始时清除。`summarySearchChunks` 先按它召回文章，再用同一查询向量取每篇文章内最相关的一个切片（得分为摘要相似度，记为 `summaryScore`）。升级前已向量化的文章由 Worker 启动时在后台补齐（只处理与当前默认模型一致的文档）。
  - 向量化并发约定：模型调用放在事务外；`documents.processing_version` 在每次重新切片时加一，向量回写前用 `SELECT ... FOR UPDATE` 比对版本，不一致则失败（参见 worker 的 `embedDocument`）。
  - `article/`：nyzdata 文章接口客户端（`client.ts`，错误信息不含 URL/token，token 失效等 `fatal` 错误中止整次同步）、ProseMirror 解析器（`parse.ts`，由 `scripts/nyz-articles/parse.mjs` 移植；修改解析规则时提升 `PARSER_VERSION` 并同步原型）、增量同步（`sync.ts`）。
  - `chunking.ts` / `prepare.ts`：纯函数，Worker 调用。
    - 结构化切片：同章节累积约 800 字，过短章节并入下一节，表格整块保留，超长段按句切分。
    - 文章只切正文章节；元信息、相关阅读、本文链接、延伸思考不进入 `content` 与切片，提取到 `documents.metadata`。
    - 每个切片的上下文前缀（标题/章节/关键词）存于 `document_chunks.context`，向量化输入为 `embeddingInput(chunk)`（前缀 + 正文）。
  - `search-terms.ts`：关键词检索词项（NFKC 规范化、中文重叠二元组、英文/数字词），写入与查询共用。词项经 `array_to_tsvector` 存入 `document_chunks.search_vector`，不经过数据库分词器；`replaceDocumentChunks` 自动生成，升级前的切片由 Worker 启动时补齐。文档元数据（关键词、项目名称、负责人、承担单位，见 `metadataSearchFields`）的词项存于 `documents.metadata_search_vector`，用于关键词检索加权：元数据命中的文档另行召回，每篇只给最佳切片加一次分（IDF × 字段权重），常见词项不加分。
  - `rag.ts`：混合检索与回答组装的纯逻辑（数据访问和模型调用由参数注入）；`repository.ts` 的 `keywordSearchChunks`（tsvector 预选 + 应用层 BM25）与 `vectorSearchChunks`（只比较同一模型与维度）提供两路召回。
  - `models.ts` / `provider.ts`：统一模型接口 `EmbeddingModel` / `ChatModel`（`streamChat`，SSE）/ `RerankModel`，基础地址追加 `/embeddings`、`/chat/completions`、`/rerank`；错误信息不含地址、密钥和响应正文。
  - `embedding.ts`：OpenAI 兼容 `/embeddings`，32 条一批。`selectEmbeddingProvider` 选唯一“启用 + 默认 + 有 embeddingModel”的 provider（数据库唯一索引保证最多一个默认）；provider 记录只保存密钥的**环境变量名**，运行时从 `process.env` 读取，密钥值不入库。
- `packages/types`：前后端共享的接口类型（`DocumentSummary` 为列表项、`DocumentRecord` 为含正文和切片的详情、`KnowledgeOverview` 等），以 `@nyz-rag/types` 引用。新增/修改接口时先改这里。
- `packages/api-client`：前端共享的 fetch 客户端（直接导出 `src/index.ts`，无需构建）。`request<T>` 把 `{ error }` 响应转为 `ApiError`；`stream` 解析 SSE（跳过心跳），未收到 `done` 即结束时调用 `onIncomplete`，读取中被中止时静默返回。
- `apps/web`、`apps/admin`：Vue 3 + Vite，各自基本是单个 `src/App.vue`，通过 `@nyz-rag/api-client` 访问 API。admin 使用 `src/adminClient.ts`（携带 Cookie、附加 CSRF 头，401 时切回 `AdminLogin.vue`）。`VITE_API_URL` 为 API 地址；Docker 构建中 `VITE_API_URL` 为空，由 Nginx 将同源 `/api/` 代理到 api:3000。
- 会话（`chat_sessions`）尚无用户归属，对所有访问者可见。追问时最近 3 轮问答作为历史送入模型（去掉旧引用编号），检索只用当前问题（未做问题改写）。问答记录的召回片段与得分存于 `message_chunks`。部分状态值是中文字面量（如任务状态 `等待中`/`运行中`/`已完成`/`失败`、来源类型 `网页站点`），修改时保持一致。

## 环境与基础设施

- API、Worker 和两个 Vite 应用都读取根目录 `.env`（gitignored，模板为 `.env.example`；默认端口 API 3001、web 5175、admin 5176）。只有 `VITE_` 前缀变量会暴露给浏览器，不要给密钥加此前缀。
- 本地复用共享的 PostgreSQL 18/pgvector（`localhost:5432`）和 Redis 8（`localhost:6379`），只使用专用 `nyzrag` 数据库/账号；API 与 Worker 必须设置相同的 `DOCUMENT_QUEUE_NAME=nyz-rag-document-processing`。不要改动或停止 booth-ai 等共享服务，禁止对共享 Redis 执行 `FLUSHALL`/`FLUSHDB`。`vector` 扩展需由管理员为非超级用户的应用账号预先创建。
- 可选独立基础设施：`docker compose --profile standalone up -d postgres redis`，端口 55433/56380。
- 容器启动器 `docker/start.mjs` 会把连接串中的 loopback 主机改写为 `host.docker.internal`。发布端口只绑定 127.0.0.1。
- `.nyz-data/`（gitignored）现在只存放旧版快照和 `scripts/nyz-articles/` 的样本数据，应用运行不再依赖它。`.nyz-data/nyz-articles/raw/` 中 200 篇原始详情可用于回归检查解析器和切片。
- `NYZ_ARTICLE_TOKEN` 只放在 `.env` 或环境变量里，不要写入代码、来源地址、日志或提交。

## 验证

修改后运行 `pnpm typecheck`、`pnpm build`、`pnpm --filter @nyz-rag/processing test`，涉及 API 或前端客户端时加跑 `pnpm --filter @nyz-rag/api test` 与 `pnpm --filter @nyz-rag/api-client test`；涉及 API/队列/Worker 链路时在本地基础设施可用时加跑集成测试。
