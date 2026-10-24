# NYZ RAG

NYZ 文章问答系统的 pnpm monorepo 初始骨架，采用 Vue 客户端、Fastify API、BullMQ Worker 和 PostgreSQL/pgvector。

## 环境要求

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- PostgreSQL 18 + pgvector、Redis 8（本机开发默认复用已有 Docker 实例）

## 本地开发

### Docker 应用分组（推荐）

准备好根 `.env` 和下文的共享数据库后运行：

```sh
docker compose up -d --build --wait
docker compose ps
```

Docker Desktop 将显示独立的 `nyz-rag` 分组，包含 `api`、`worker`、`web`、`admin`，不会新建 PostgreSQL 或 Redis。用户端为 http://localhost:5175，管理后台为 http://localhost:5176，API 健康检查为 http://localhost:3001/health。

- 应用镜像统一使用仓库根 `Dockerfile` 构建；修改代码后重新运行上述构建启动命令。
- `.env` 只注入后端运行时，不进入镜像。后端启动器将连接串中的 `localhost` / `127.0.0.1` / `::1` 转为 `host.docker.internal`，通过宿主机端口连接已有服务；非本机地址保持不变。管理端配置的模型供应商地址同样处理（启动器设置 `NYZ_LOOPBACK_HOST`），本机的模型或代理填 `http://127.0.0.1:<端口>/v1` 即可，容器内与宿主机上的命令行都能访问；不要填 `host.docker.internal`，宿主机上它可能解析为局域网 IP，只监听 127.0.0.1 的服务无法访问。
- 前端使用 Nginx 提供构建产物并将 `/api/` 代理到 API，浏览器不依赖容器 DNS，也不需要在镜像中配置宿主机 API 地址。Docker 构建固定使用同源 API，不使用本机的 `VITE_API_URL`。
- 元数据与向量都存于 `DATABASE_URL` 指向的 PostgreSQL，容器不挂载数据目录；API 和 Worker 启动时自动执行数据库迁移。不要同时启动本机 Worker 和容器 Worker 消费同一队列。
- 仅将端口暴露到 `127.0.0.1`。管理后台需在 `.env` 设置 `ADMIN_PASSWORD`（16 位以上随机密码）后才能登录；对外部署时设置实际 HTTPS 来源的 `ADMIN_ORIGINS` 与 `ADMIN_COOKIE_SECURE=true`。
- `docker compose down` 移除本项目应用容器，不会停止外部共享数据库。
- API 健康检查仅代表 HTTP 可用，Worker 为长驻队列进程；完整依赖状态仍需通过实际文档任务验证。

#### 常用管理命令

在仓库根目录按需执行：

```sh
# 修改代码后重新构建并启动
docker compose up -d --build --wait

# 查看运行状态和日志
docker compose ps
docker compose logs -f api worker

# 停止本项目应用，不影响共享数据库
docker compose stop
```

日志跟踪期间按 `Ctrl+C` 仅退出日志查看，不会停止容器。应用容器运行时无需再执行 `pnpm dev`。

### 本机进程开发

先停止上述应用容器，避免端口和任务消费者冲突：

```sh
cp .env.example .env
pnpm install
pnpm dev
```

- 已有 `.env` 时不要覆盖；新建时先按下文准备数据库，并填写实际数据库密码。
- 客户端：http://localhost:5175
- 管理后台：http://localhost:5176（另行运行 `pnpm --filter @nyz-rag/admin dev`）
- API 健康检查：http://localhost:3001/health
- API 问答入口：单次问答 `POST http://localhost:3001/api/chat`，JSON body 为 `{ "question": "..." }`；会话问答先 `POST /api/chat/sessions` 创建会话，再 `POST /api/chat/sessions/:id/stream` 以 SSE 流式返回（body 为 `{ "question": "..." }` 或 `{ "regenerate": "<messageId>" }`）
- 文章详情：`GET /api/documents/:id` 仅返回已就绪文档的公开字段；用户端引用可打开 `/#/documents/:id`，保留问答页面状态。
- 检索范围：搜索、单次问答与 SSE 请求均可附带 `filters`，例如 `{ "publishedFrom": "2026-01-01", "publishedTo": "2026-10-21", "categories": ["科研"], "tags": ["钠电"], "scenarios": ["储能"], "sourceId": "..." }`。日期按 UTC 整日包含首尾；各列表精确匹配、列表内 OR、字段间 AND，空列表不限制。筛选用于当前请求（重新生成亦使用当前筛选），不绑定或持久化到会话。

nyzdata 文章 API 增量同步（数据源只支持文章接口，已移除网页站点采集）、结构化切片、Embedding/pgvector 写入，以及混合检索（关键词 + 向量，可选 Rerank）和模型问答已接通，用户端支持多轮会话、流式输出、停止生成、重新生成与复制回答；模块进度见 [模块清单](docs/module-status.md)。

API、Worker、web 和 admin 均读取根目录 `.env`。前端只向浏览器暴露 `VITE_` 前缀变量，不要给数据库密码或模型密钥添加此前缀。先在 `.env` 中设置 `NYZ_SECRET_KEY`（至少 32 个字符，API 与 Worker 相同），后台填写的模型 API Key 与 nyzdata token 用它加密保存；更换后需重新填写。模型在管理后台「模型配置」中分两步配置：先添加供应商——选择服务类型（硅基流动、OpenAI、本地 Ollama 或其他 OpenAI 兼容服务）、填写 API Key（本地模型可不填，也可改填密钥环境变量名），可点「测试连接」；再在「业务模型」中为 Chat、Embedding、Rerank 分别选择供应商和模型（从供应商的模型列表中选或直接输入），三者可以来自不同供应商，例如硅基流动的 `BAAI/bge-m3` 做向量化、DeepSeek 做问答。问答使用 Chat 模型（温度与最大 Token 在 Chat 模型中设置），未配置或调用失败时直接摘录原文片段；配置 Rerank 模型并在知识库中开启重排序后，召回结果会先经过重排序。正在被业务模型使用的供应商不能删除。更换 Embedding 模型后需要重新向量化全部文档。检索参数（召回数量、相似度阈值、最大上下文、回答提示词）取最近创建的知识库，请求也可通过 `knowledgeBaseId` 指定。

接入 nyzdata 文章时，在管理后台添加「文章 API」来源，地址填文章列表接口，例如 `https://nyzdata.nenghe.com/nyzfoxx/article?tagKey=9302258412`。地址里不要带 token，token 在数据源页「nyzdata 接口 Token」中设置（加密保存，所有来源共用，修改后下次同步生效）。每次同步按 `updateTime` 只获取新增或变化的文章，单次最多处理 `NYZ_ARTICLE_SYNC_LIMIT` 篇（默认 200），请求间隔与超时由 `NYZ_ARTICLE_REQUEST_DELAY_MS` / `NYZ_ARTICLE_REQUEST_TIMEOUT_MS` 设置。首次全量同步超过上限时，再次点击同步即可从上次的位置继续，失败的文章也会在下次同步重试。原始文章 JSON 保存在数据库中，解析规则升级后在文档管理中「重新处理」即可，无需重新请求接口。

元数据与向量都存于 PostgreSQL，表结构用 Drizzle ORM 定义在 `packages/processing/src/schema.ts`。修改后运行 `pnpm db:generate` 生成迁移；API 和 Worker 启动时自动执行迁移，也可手动运行 `pnpm db:migrate`。关键词检索的词项随切片生成；从旧版本升级时，Worker 启动会自动为已有切片补齐，修改词项规则后运行 `pnpm db:reindex-search` 全量重建。迁移 `0011` 删除网页站点来源及其文档（以及没有原始文章 JSON 的文档）；原本是这些文档重复项的文章会标记为处理失败，需在文档管理中「重新处理」。

迁移 `0005` 为 384、512、768、1024、1536、2000 维向量建立 HNSW 部分表达式索引，其他维度继续精确检索（`vector` HNSW 上限为 2000 维）。HNSW 为近似召回，过滤后候选不足时自动精确回退。已有较大语料首次建索引会延长启动并阻塞切片写入，宜在维护窗口先运行 `pnpm db:migrate`；迁移连接不受普通查询的 10 秒超时限制。本轮只验证了索引执行路径和正确性，未作全量速度或召回率承诺。

检索验证使用 `pnpm --filter @nyz-rag/processing test`。要运行数据库与 API/队列集成验证，在 PowerShell 中执行 `$env:NYZ_INTEGRATION_TEST='1'; pnpm --filter @nyz-rag/processing exec tsx --env-file-if-exists=../../.env --test test/*.test.ts`，测试使用临时 schema 和唯一队列，不消费业务队列，也不填充业务数据库。

检索评估命令（仓库根目录执行）：

```sh
# 本地清洗样本上的词项重叠基线，逐条校验标注证据
pnpm evaluate:retrieval --mode=offline
# 已入库文章上的关键词检索基线，只读，不迁移或填充数据库
pnpm evaluate:retrieval --mode=db
# 只评估 v2 数据集的 dev 或 test 划分
pnpm evaluate:retrieval --mode=db --dataset=<JSON绝对路径> --split=dev
```

默认评估集为 `packages/processing/test/evaluation/retrieval-dataset.json`，包含 50 条文章衍生合成问题，不是真实用户问题，也未经过人工标注复核。离线模式默认读取 `.nyz-data/nyz-articles/clean`（样本未随仓库提交），可用 `--corpus=<清洗目录绝对路径>` 覆盖；数据库模式不依赖本地样本。支持 `--dataset=<JSON绝对路径>` 和 `--k=1,3,5,10`。结果为文章去重后的 Recall@K、MRR、线性增益 nDCG@K；数据库模式按就绪文档实际覆盖范围报告缺失标注数量，有缺失时返回非零退出码，不能将部分语料指标当完整基线。数据库候选为前 `max(20,K)` 个切片，再按文章去重，不代表全库文章级排序。这两种基线均不评估向量、Rerank 或回答质量，混合检索评估仍待补充。

合成评估集生成命令（方案见 `docs/evaluation-plan.md`）：按文章分层抽样，用业务模型中的 Chat 模型生成问题、参考答案与原文证据，经程序校验和「审核」模型审核，未通过时带原因重试，最多 3 次。工作文件在 `.nyz-data/evaluation/<名称>/`，中断后重新运行会从未完成的文章继续。会调用模型并产生费用，数据库只读。

```sh
# 首次运行冻结语料快照并抽样（默认 400 篇、种子 20261023）；--limit 只处理前 N 篇（试点）
pnpm evaluate:generate --name=nyz-rag-synthetic-v1 --limit=50 --concurrency=3
# 全部样本完成后导出 schemaVersion 2 数据集（默认写入 packages/processing/test/evaluation/<名称>.json）
pnpm evaluate:generate --name=nyz-rag-synthetic-v1 --freeze
```

### 共享 Docker 服务（默认）

- PostgreSQL：复用 `agent-template-server-postgres-1`，地址 `localhost:5432`，仅使用本项目的 `nyzrag` 数据库和同名账号。
- Redis：复用 `agent-template-server-redis-1`，地址 `localhost:6379`，通过 `DOCUMENT_QUEUE_NAME=nyz-rag-document-processing` 隔离任务队列。API 与 Worker 必须使用相同队列名。
- 本仓库默认 `docker compose up` 只启动应用，不管理这些共享容器，也不修改或停止 `booth-ai` 的数据库、Redis。
- 共享容器仍由其原 Compose 项目管理；停止它们会影响本项目。禁止对共享 Redis 执行 `FLUSHALL` / `FLUSHDB`，队列名隔离不代表资源或权限隔离。

在新的共享实例上首次接入时，由数据库管理员执行以下 SQL（替换密码；账号和数据库只创建一次）：

```sql
CREATE ROLE nyzrag LOGIN PASSWORD 'replace-with-a-local-password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE nyzrag OWNER nyzrag;
```

再连接 `nyzrag` 数据库，以管理员身份执行 `CREATE EXTENSION IF NOT EXISTS vector;`。应用账号无需超级用户权限，启动时会通过迁移自行建表。将实际连接串填入根 `.env` 的 `DATABASE_URL`；密码中的特殊字符需要 URL 编码。

### 独立 Docker 服务（可选）

仅在不使用共享实例时运行 `docker compose --profile standalone up -d postgres redis`，先只启动基础设施。该配置使用 PostgreSQL 18 + pgvector、Redis 8，端口为 `55433` / `56380`，只绑定本机。同步把 `.env` 改为：

```dotenv
DATABASE_URL=postgresql://nyzrag:nyzrag@localhost:55433/nyzrag
REDIS_URL=redis://localhost:56380
```

等待独立数据库和 Redis 健康后，再运行 `docker compose up -d --build --wait` 启动应用，或使用 `pnpm dev` 本机开发。容器启动器同样会将这些本机连接地址转为宿主机地址。

独立环境的固定密码仅用于本地开发。PostgreSQL 18 使用新的 `postgres18_data` 卷和 `/var/lib/postgresql` 挂载路径，不会迁移旧 PostgreSQL 16 卷中的数据；有旧数据时应先备份再迁移，不能直接复用旧主版本的数据目录。

## Workspace

- `apps/web`：Vue 3 + Vite 用户端
- `apps/admin`：Vue 3 + Vite 管理后台，运行 `pnpm --filter @nyz-rag/admin dev`
- `apps/api`：Fastify HTTP API
- `apps/worker`：BullMQ 文档处理队列消费者
- `packages/types`：前后端共享接口类型
- `packages/processing`：API/Worker 共用的数据库访问（Drizzle）、文章接口与解析、结构化切片、模型接口（Embedding/Chat/Rerank）和混合检索
