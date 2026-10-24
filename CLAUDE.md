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
pnpm --filter @nyz-rag/<api|web|admin|worker|types|processing|api-client|ui> dev|build|typecheck
```

- 测试均使用 Node 内置 test runner + tsx：`pnpm --filter @nyz-rag/processing test`、`pnpm --filter @nyz-rag/api test`（契约测试，用 Fastify inject 和注入的假队列，不需要数据库/Redis）、`pnpm --filter @nyz-rag/api-client test`。
- 单个测试文件：`pnpm --filter @nyz-rag/processing exec tsx --test test/article.test.ts`（解析、切片、文章接口与增量同步）、`test/retrieval.test.ts`（检索词项、RRF/Rerank、Prompt 组装、Chat 流解析）或 `test/embedding.test.ts`；按名称过滤加 `--test-name-pattern "<名称>"`。
- 检索评估（`docs/evaluation-plan.md`）：数据集格式与指标在 `evaluation.ts`（schemaVersion 2，兼容读取 v1），合成题的抽样、提示与程序校验在 `synthetic-questions.ts`（修改提示或校验规则时提升 `SYNTHETIC_PROMPT_VERSION`）。`pnpm evaluate:generate --name=<名称> [--limit=N]` 用 Chat 模型生成、「审核」模型（业务模型 `review`）审核，会调用模型产生费用，工作文件在 `.nyz-data/evaluation/<名称>/`，可断点续跑，`--freeze` 导出数据集。语料读取两条命令共用 `src/cli/evaluation-corpus.ts`。`pnpm evaluate:retrieval --mode=hybrid --dataset=<路径> --split=dev --name=<运行名>` 调用问答使用的 `retrieve()`（最近创建的知识库参数与业务模型配置中的 Embedding、Rerank），按 `--variant`（keyword、vector、summary、fused、rerank）消融，`--context`（topk、budget、section）选择回答上下文的组装方式，变体裁剪、指标与对比的纯逻辑在 `evaluation-run.ts`，运行记录保存到 `.nyz-data/eval-runs/`；`pnpm evaluate:compare <运行A> <运行B>` 对比两次运行（`offline`/`db` 模式只是关键词冒烟测试）。切片规则的实验用 `pnpm evaluate:index --schema=eval_<名称> --chunker=1|2` 在 `nyzrag` 库的单独 schema 中复制文章与模型配置并重新切片、向量化（调用 Embedding，不经过队列，不改业务 schema），评估时加 `--schema=eval_<名称>`。回答层评估 `pnpm evaluate:answer --dataset=<路径> --split=dev --name=<运行名> [--context=topk|budget]` 按问答的方式检索并调用 Chat 模型回答（不保存问答记录），统计来源文章引用，由审核模型评审忠实度、完整度与引用，会产生费用；纯逻辑在 `evaluation-answer.ts`（修改评审提示或统计规则时提升 `ANSWER_EVAL_VERSION`），工作文件在 `.nyz-data/eval-answers/<运行名>/`，可断点续跑，`--compare <A> <B>` 逐题对比。
- 集成测试 `test/pipeline.test.ts` 默认跳过；设置 `NYZ_INTEGRATION_TEST=1` 并提供 `DATABASE_URL`、`REDIS_URL` 启用。它用 tsx 直接拉起 API 和 Worker 源码，使用临时 PostgreSQL schema（连接串 `options=-c search_path=<schema>,public`，结束后删除）、唯一队列名和本地模拟 Embedding 服务。
- 数据库（Drizzle）：修改 `packages/processing/src/schema.ts` 后运行 `pnpm db:generate` 生成迁移（会去掉外键里写死的 `"public".`，使表可建在任意 schema）；`pnpm db:migrate` 手动执行迁移（API/Worker 启动时也会自动执行）；`pnpm db:reindex-search` 按当前词项规则重建全部切片与文档元数据的关键词检索词项（修改 `search-terms.ts` 后执行）。
- 没有配置 lint。`turbo.json` 存在但根脚本未使用 Turborepo。
- `@nyz-rag/processing` 通过 `dist/` 导出：单独启动/类型检查 API 或 Worker 前须先 `pnpm --filter @nyz-rag/processing build`，修改 processing 后也要重新构建。`@nyz-rag/types`、`@nyz-rag/api-client`、`@nyz-rag/ui` 直接导出源码，无需构建。
- 容器方式：`docker compose up -d --build --wait`（只启动 api/worker/web/admin）。不要同时运行本机 Worker 和容器 Worker。

## 架构

- `apps/api`：Fastify，按领域拆为插件（`chat`、`search`、`documents`、`data-sources`、`crawl-tasks`、`knowledge-bases`、`model-providers`、`common`），`src/app.ts` 的 `buildApp({ queue })` 组装（测试注入假队列），`src/index.ts` 只做迁移与监听。
  - 请求/响应校验用 Fastify JSON Schema，集中在 `src/schemas.ts`，以 `"METHOD /path"` 为键由 `common.ts` 的 `onRoute` 钩子挂载；新增或修改路由必须同步此注册表（`test/app.test.ts` 校验路由与 schema 一一对应）。Ajv 关闭类型强制转换，参数 ID 必须是 UUID（公开文章接口 `GET /api/documents/:id` 除外，未知 ID 一律 404），请求体拒绝未知字段；响应 schema 只输出声明过的字段，给接口加字段时漏改 schema 会被静默丢弃。
  - `common.ts` 的错误处理钩子把所有错误统一为 `{ error: string }`：4xx 返回原因，其余记日志并返回 `Internal server error`。路由内直接 `reply.code(4xx).send({ error })`。
  - 队列访问只经过 `src/queue.ts`（`DocumentQueue`）：文档级 jobId `document-<id>`，来源同步 jobId `sync-<taskId>`，`hasDocumentJob` / `hasSourceJob` 做重复任务检测。
  - 问答（`src/chat.ts`）在请求内完成检索与生成（`answerQuestion`）：`retrieve`（关键词 + 切片向量 + 摘要召回三路，RRF 合并，知识库开启时 Rerank；两路向量召回共用一次查询 Embedding）→ `buildAnswerContext` → 流式调用业务模型配置中的 Chat 模型（Embedding、Rerank 同样取各自配置的供应商与模型）；未配置 Chat 模型、密钥不可用或调用失败时返回原文摘录（`answerMode: "extractive"`），向量检索/摘要召回/Rerank 失败只降级并记日志。检索参数取 `knowledgeBaseId` 指定或最近创建的知识库。用户端接口：单次问答 `/api/chat`；会话 `/api/chat/sessions`（列表/创建）、`/api/chat/sessions/:id/messages`、`DELETE /api/chat/sessions/:id`；流式问答 `POST /api/chat/sessions/:id/stream`（SSE，事件 `source`/`token`/`done`/`error`，`done` 的回答为准；`{ regenerate: messageId }` 只能重新生成最后一轮，被替换的消息标记 `superseded_at`，仍保留在问答记录中；客户端断开时中止模型调用且不保存）；以及 `/api/search`、`/api/messages/:id/feedback`。管理端接口在 `/api/admin/*`（sources、documents、knowledge-bases、model-providers、model-settings、settings、chat-logs、knowledge），由 `src/admin-auth.ts` 的 `onRequest` 钩子统一鉴权：单管理员账号（`ADMIN_USERNAME`/`ADMIN_PASSWORD`，未设密码时返回 503），登录 `/api/admin/auth/login`、`/session`、`/logout`；会话为 HttpOnly + SameSite=Strict Cookie（Path=/api/admin，8 小时），存于 Redis（键前缀 `<DOCUMENT_QUEUE_NAME>:admin-auth:`，凭据变更即全部失效），校验 `ADMIN_ORIGINS` 精确来源，非 GET/HEAD 须带 `X-NYZ-Admin: 1` 防 CSRF，登录按 IP 与全局限流。测试用 `buildApp({ adminAuth, authStore })` 注入配置和内存存储（`test/auth-helpers.ts`）。
  - 用户端身份（`src/user-auth.ts`）：`/api/chat*`、`/api/messages/*`、`/api/auth/*` 由 `onRequest` 钩子解析身份——已登录为邮箱账号（`nyz_user_session`，Redis 存会话，30 天），否则为匿名访客（`nyz_visitor`，服务端生成的随机值，1 年；数据库只存其 SHA-256 `visitor_hash`，不依赖 Redis）。Cookie 均为 HttpOnly + SameSite=Strict、Path=/api；这些路由的非 GET 请求须带 `X-NYZ-Client: 1`（防 CSRF），`WEB_ORIGINS` 中的来源才允许携带 Cookie 跨域。路由内用 `requestOwner(request)` 取归属，会话、消息、流式问答、删除与反馈都按归属过滤，他人的数据一律 404；`/api/search` 与公开文章接口不涉及归属。账号流程：注册与找回密码都用 6 位邮件验证码（先验证邮箱再建账号；已注册邮箱收到提醒而非验证码，响应相同），密码用 scrypt（`src/passwords.ts`）；登录/注册/重置时把当前访客的会话与问答归入账号（`claimVisitorData`），退出后浏览器换成新访客；修改/重置密码与停用账号提升 `users.session_version`，使旧会话失效。发信在 `src/mailer.ts`（nodemailer，`SMTP_*`），未配置 `SMTP_HOST` 时非生产环境把邮件写入日志、生产环境相关接口返回 503。测试用 `buildApp({ userAuth, userAuthStore, mailer, users })` 注入内存实现（`test/auth-helpers.ts`）。管理端 `/api/admin/users` 列出与停用账号，问答记录带 `ownerType`/`userEmail`。公开 `/api/knowledge` 只返回统计，完整概览在 `/api/admin/knowledge`；`/api/admin/knowledge/events`（SSE，`src/knowledge-events.ts`）在有连接时由进程内共用的轮询每 2 秒读取概览、变化才推送 `overview` 事件，单条连接 5 分钟后由服务端断开、浏览器重连时重新鉴权，管理端数据源页用它显示同步进度（Worker 写入 `crawl_tasks` 的 `processed_count`/`failed_count`/`article_limit`）。API 只负责改元数据和入队，不做采集/切片/向量化。
- `apps/worker`：BullMQ 消费者（`src/index.ts`，concurrency 1），处理三种 job：
  - `sync-source`：数据源只有 `文章 API` 一种（数据库约束保证，网页站点采集已移除）。来源 `url` 为 nyzdata 文章列表接口，token 是全局一个、在管理端数据源页配置的密钥设置（`secret_settings`，`PUT /api/admin/settings/article-token`，只写不读），Worker 每次同步时读取（API 拒绝带 token 的地址），请求间隔/超时由 `NYZ_ARTICLE_REQUEST_DELAY_MS` / `NYZ_ARTICLE_REQUEST_TIMEOUT_MS` 控制。由 `syncArticles` 按 `updateTime` 增量同步，回填进度与失败文章存于 `data_sources.sync_state`。详情原样存入 `documents.raw_json`（必填），`external_id`（必填）为 articleKey，同一来源内按它识别文章；入库后在同一事务内由 `processDocument` 切片，再自动向量化。
  - `reprocess-document`：用当前解析器从 `raw_json` 重新解析、切片并清除旧向量，再自动向量化，不请求接口。
  - 清洗切片统一走 processing 的 `processDocument`（`process.ts`），其中做正文指纹去重：与已有主文档（同 `content_hash`、最早入库的非重复文档）相同则标记 `duplicate_of`、处理状态 `duplicate`，只保存清洗结果，不切片、不向量化、不参与检索与统计（`documentFilter` 排除）；正文不足 50 字不判重。主文档内容变化时名下重复文档重新判定、最早一篇接替；删除主文档时 API（`deleteDocument`）在事务内选出接替者并入队 `reprocess-document`。凡改变重复关系的操作都先用 `lockContentHashes` 按新旧指纹加事务级咨询锁。
  - `embed-document`：对已切片文档向量化（手动重试入口）。
  - 文档级 job 使用 `jobId: document-<id>`，API 据此及 active 的 `sync-source` 判断重复任务并返回 409；同一来源已有等待/运行中的 `sync-source` 时再次同步也返回 409。
- `packages/processing`：API 与 Worker 共享的运行时逻辑。
  - `schema.ts` / `db.ts`：Drizzle ORM（`node-postgres` 驱动，`casing: "snake_case"`）。`db.ts` 提供连接池（`DATABASE_URL` 必填）、`getDb()`、`withTransaction`、`migrate()`；迁移由 drizzle-kit 生成到 `migrations/`，运行时用 Drizzle migrator 执行，外加咨询锁串行，迁移记录表 `__drizzle_migrations` 放在当前 schema。不要手改已执行的迁移文件。
  - Drizzle 在单表查询里渲染列名不带表名：`sql` 模板中的相关子查询引用外层列时须用 `repository.ts` 的 `outer()` 显式限定（查询构建器生成的子查询不受影响）。
  - `repository.ts`：按实体的数据访问函数（数据源、任务、文档/切片、知识库、模型供应商、问答记录），负责数据库行与 `@nyz-rag/types` 结构的映射。需要多步一致性的操作接收事务内的执行器（`Executor`）。向量存在 `document_chunks.embedding`（pgvector，不限维度），切片和向量随文档级联删除。
  - 文章级向量：`documents.summary_embedding` 存「标题 + 摘要」（`summaryEmbeddingInput`）的向量，与切片在同一次 Embedding 调用中生成、同一事务写入，模型与维度沿用 `documents.embedding_model` / `embedding_dimensions`（常用维度有 HNSW 部分索引）；没有摘要的文章为空，重新切片或重新向量化开始时清除。`summarySearchChunks` 先按它召回文章，再用同一查询向量取每篇文章内最相关的一个切片（得分为摘要相似度，记为 `summaryScore`）。升级前已向量化的文章由 Worker 启动时在后台补齐（只处理与当前默认模型一致的文档）。
  - 向量化并发约定：模型调用放在事务外；`documents.processing_version` 在每次重新切片时加一，向量回写前用 `SELECT ... FOR UPDATE` 比对版本，不一致则失败（参见 worker 的 `embedDocument`）。
  - `dedup.ts`：去重纯函数——`normalizeUrl`（去片段、默认端口、跟踪参数，查询参数排序，路径不动；用于规范文章地址）、`contentFingerprint`（检索正文 NFKC + 去空白后 SHA-256，写入 `content_hash`）。
  - `article/`：nyzdata 文章接口客户端（`client.ts`，错误信息不含 URL/token，token 失效等 `fatal` 错误中止整次同步）、ProseMirror 解析器（`parse.ts`，由 `scripts/nyz-articles/parse.mjs` 移植；修改解析规则时提升 `PARSER_VERSION` 并同步原型）、标题解析（`title.ts`，期刊词典 + 「机构 + 人名」规则，结果存于 `metadata.titleMeta`，只在识别出期刊时提取机构）、增量同步（`sync.ts`）。
  - `chunking.ts` / `prepare.ts`：纯函数，Worker 调用。
    - 结构化切片：同章节累积约 800 字，过短章节并入下一节，表格整块保留，超长段按句切分（切片规则 1，`CHUNKER_VERSION`，写入 `documents.chunker_version`）。
    - 切片规则 2（父块 + 子块，`chunkSections`，见 `docs/chunking-design.md` 第六节）已实现但未启用：父块存于 `document_sections`，子块的 `section_id` 指向父块，`rag.ts` 的 `buildSectionContext` 按父块组装上下文；目前只用于评估实验索引，问答仍用 `buildAnswerContext`。
    - 文章只切正文章节；元信息、相关阅读、本文链接、延伸思考不进入 `content` 与切片，提取到 `documents.metadata`。
    - 每个切片的上下文前缀（标题/章节/关键词）存于 `document_chunks.context`，向量化输入为 `embeddingInput(chunk)`（前缀 + 正文）。
  - `search-terms.ts`：关键词检索词项（NFKC 规范化、中文重叠二元组、英文/数字词），写入与查询共用。词项经 `array_to_tsvector` 存入 `document_chunks.search_vector`，不经过数据库分词器；`replaceDocumentChunks` 自动生成，升级前的切片由 Worker 启动时补齐。文档元数据（关键词、项目名称、负责人、承担单位，见 `metadataSearchFields`）的词项存于 `documents.metadata_search_vector`，用于关键词检索加权：元数据命中的文档另行召回，每篇只给最佳切片加一次分（IDF × 字段权重），常见词项不加分。
  - `rag.ts`：混合检索与回答组装的纯逻辑（数据访问和模型调用由参数注入）；`repository.ts` 的 `keywordSearchChunks`（tsvector 预选 + 应用层 BM25）与 `vectorSearchChunks`（只比较同一模型与维度）提供两路召回。
  - `models.ts` / `provider.ts`：统一模型接口 `EmbeddingModel` / `ChatModel`（`streamChat`，SSE）/ `RerankModel`，基础地址追加 `/embeddings`、`/chat/completions`、`/rerank`，`listProviderModels` 读 `/models` 供后台测试连接与选择模型；错误信息不含地址、密钥和响应正文。供应商（`model_providers`）只描述连接（地址、密钥、启用），不含模型；业务模型（`model_settings`，主键为用途 `chat` / `embedding` / `rerank` / `review`，`review` 为审核模型，供评估集题目审核等离线任务使用）为每项用途选一个供应商与模型，温度与最大 Token 只用于 Chat 与审核，被使用的供应商不能删除（外键 RESTRICT，接口返回 409）。运行时用 `getModelSelections()` / `getModelSelection(capability)` 取 `ModelSelection`（供应商配置 + 模型名，供应商停用视为未配置），模型调用函数接收它而不是供应商；`usableModel` 过滤密钥不可用的。管理接口：`GET /api/admin/model-settings`、`PUT|DELETE /api/admin/model-settings/:capability`、`GET /api/admin/model-providers/:id/models`。
  - `secrets.ts`：后台配置的密钥（模型 API Key、nyzdata token）以 AES-256-GCM 加密入库，主密钥为环境变量 `NYZ_SECRET_KEY`（API 与 Worker 相同，≥32 字符），密文绑定用途（供应商 ID 或设置名）。接口只返回 `hasApiKey` / `configured`，从不返回密钥；运行时用 `listModelProviderConfigs()`（带密文）而非 `listModelProviders()`。`providerCredential` 依次取已保存密钥 → `credentialEnv` 指定的环境变量 → 无（不带认证头，本地模型）。更换主密钥后已保存的密钥无法解密，需在后台重新填写。
  - `embedding.ts`：OpenAI 兼容 `/embeddings`，32 条一批。`requireEmbeddingModel` 在未配置 Embedding 模型时报错。
- `packages/types`：前后端共享的接口类型（`DocumentSummary` 为列表项、`DocumentRecord` 为含正文和切片的详情、`KnowledgeOverview` 等），以 `@nyz-rag/types` 引用。新增/修改接口时先改这里。
- `packages/api-client`：前端共享的 fetch 客户端（直接导出 `src/index.ts`，无需构建）。`request<T>` 把 `{ error }` 响应转为 `ApiError`；`stream` 解析 SSE（跳过心跳），未收到 `done` 即结束时调用 `onIncomplete`，读取中被中止时静默返回。
- `packages/ui`：shadcn-vue 组件（reka-ui + Tailwind CSS v4），直接导出源码，无需构建：`@nyz-rag/ui/components/<name>`、`@nyz-rag/ui/lib/utils`（`cn`）、`@nyz-rag/ui/lib/toast`、`@nyz-rag/ui/confirm`（`confirm()` 返回 Promise，替代 `window.confirm`，页面需挂载一个 `<ConfirmDialog />`）、`@nyz-rag/ui/theme.css`（主题变量，配色沿用原界面）。新增组件用 `pnpm --filter @nyz-rag/ui add-component <name...>`：它调用 shadcn-vue CLI 后把 `@/` 别名改为相对路径、换行统一为 LF，并移除 CLI 误装的 `cn` 包；不要直接运行 CLI。生成的组件可以按需修改（如 Badge 的 `success`/`muted`/`brand` 变体、中文无障碍文案）。
- `apps/web`、`apps/admin`：Vue 3 + Vite + Tailwind（`@tailwindcss/vite`），界面组件一律用 `@nyz-rag/ui`，样式写 Tailwind 类，`src/style.css` 只引入 Tailwind/主题并保留少量无法用类表达的样式（文章 Markdown 正文、流式光标等）；应用样式表须 `@source` 扫描 `packages/ui/src`。图标用 `@lucide/vue`（`lucide-vue-next` 已弃用）。提示用 toast，确认用 `confirm()`。reka-ui 的 `SelectItem` 不接受空字符串，admin 的“全部”筛选经 `components/FilterSelect.vue` 用哨兵值转换。通过 `@nyz-rag/api-client` 访问 API。web：`App.vue`（问答、账号与布局：固定顶栏 + 左侧会话栏 `components/SessionSidebar.vue` + 对话区（输入框固定在底部）+ 点击引用 [n] 打开的来源面板 `components/SourcePanel.vue`，宽屏 ≥1280px 为第三栏、窄屏为抽屉）、`AccountDialog.vue`、`components/AnswerMarkdown.vue`（回答的 Markdown 渲染，[n] 渲染为引用按钮）、`components/ArticleView.vue`（公开文章页）；Markdown 都由 `markdown.ts` 解析。admin：`App.vue` 负责登录态与布局，各模块在 `views/*`（离开模块即卸载、状态随之清空，再次点击当前模块会重新加载），共用的客户端与数据源列表在 `workspace.ts`；`src/adminClient.ts` 携带 Cookie、附加 CSRF 头，401 时切回 `AdminLogin.vue`。`VITE_API_URL` 为 API 地址；Docker 构建中 `VITE_API_URL` 为空，由 Nginx 将同源 `/api/` 代理到 api:3000。
- 会话（`chat_sessions`）与问答（`chat_messages`）按 `user_id` 或 `visitor_hash` 归属（至多其一；会话中的问答跟随会话归属，单次问答取提问者），两者都为空的是用户体系上线前的历史数据，只在管理端可见。追问时最近 3 轮问答作为历史送入模型（去掉旧引用编号），检索只用当前问题（未做问题改写）。问答记录的召回片段与得分存于 `message_chunks`；用户端的来源（`ChatSource.excerpts`）附带该文章送入模型的片段摘录（`buildAnswerContext` 生成，历史会话由 `listSessionMessages` 从 `message_chunks` 按文章聚合），管理端问答记录不含。部分状态值是中文字面量（如任务状态 `等待中`/`运行中`/`已完成`/`失败`、来源类型 `文章 API`），修改时保持一致。

## 环境与基础设施

- API、Worker 和两个 Vite 应用都读取根目录 `.env`（gitignored，模板为 `.env.example`；默认端口 API 3001、web 5175、admin 5176）。只有 `VITE_` 前缀变量会暴露给浏览器，不要给密钥加此前缀。
- 本地复用共享的 PostgreSQL 18/pgvector（`localhost:5432`）和 Redis 8（`localhost:6379`），只使用专用 `nyzrag` 数据库/账号；API 与 Worker 必须设置相同的 `DOCUMENT_QUEUE_NAME=nyz-rag-document-processing`。不要改动或停止 booth-ai 等共享服务，禁止对共享 Redis 执行 `FLUSHALL`/`FLUSHDB`。`vector` 扩展需由管理员为非超级用户的应用账号预先创建。
- 可选独立基础设施：`docker compose --profile standalone up -d postgres redis`，端口 55433/56380。
- 容器启动器 `docker/start.mjs` 会把连接串中的 loopback 主机改写为 `host.docker.internal`。发布端口只绑定 127.0.0.1。
- `.nyz-data/`（gitignored）现在只存放旧版快照和 `scripts/nyz-articles/` 的样本数据，应用运行不再依赖它。`.nyz-data/nyz-articles/raw/` 中 200 篇原始详情可用于回归检查解析器和切片。
- nyzdata token 与模型 API Key 只在管理端填写（加密入库），不要写入代码、来源地址、日志或提交；`NYZ_SECRET_KEY` 只放在 `.env` 或环境变量里。

## 验证

修改后运行 `pnpm typecheck`、`pnpm build`、`pnpm --filter @nyz-rag/processing test`，涉及 API 或前端客户端时加跑 `pnpm --filter @nyz-rag/api test` 与 `pnpm --filter @nyz-rag/api-client test`；涉及 API/队列/Worker 链路时在本地基础设施可用时加跑集成测试。
