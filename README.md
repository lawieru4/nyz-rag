# NYZ RAG

基于 nyzdata 文章 API 的知识问答系统，采用 pnpm workspace，包含 Vue 3 用户端、独立管理后台、Fastify API、BullMQ Worker，以及开发中的微信小程序（uni-app）。文章元数据、原始 JSON、切片与向量统一保存在 PostgreSQL/pgvector，Redis 用于任务队列、认证状态和请求限流。

## 功能概览

| 模块 | 已实现能力 |
| --- | --- |
| 用户端 | 匿名问答、邮箱验证码注册与密码找回、登录、多轮会话与历史管理、SSE 流式回答、停止/重新生成/复制、赞踩反馈、引用与文章详情、检索筛选 |
| 管理后台 | 数据源与同步任务（实时进度与后台任务积压）、文档详情/重新处理/向量化/删除、知识库参数、模型配置、问答记录（含降级原因与改写结果）、问答统计、用户启停、管理员与角色权限、操作日志、个人资料 |
| 文章处理 | 按频率自动同步、增量/全量详情巡检与断点续传、失败文章重试、原始 JSON 留存、结构化切片、正文指纹去重、切片与摘要向量化 |
| 检索问答 | 追问改写为独立问题、BM25 与元数据加权、切片向量和文章摘要向量三路召回、RRF 融合、可选 Rerank、引用校验、模型生成与原文摘录降级 |
| 后台任务 | PostgreSQL 持久化操作、队列投递、运行租约与过期回收、丢失队列任务重新投递、向量化暂时故障退避重试、Worker 心跳与优雅关停 |
| 评估工具 | 关键词基线、混合检索消融与运行对比、合成题生成、多轮追问题派生与改写重放、失败题复判、回答评审、独立实验索引 |
| 运维 | 就绪检查、本地打包镜像与 1Panel 生产编排、数据库备份恢复演练 |

### 当前边界

- 数据源仅支持「文章 API」，不支持网页站点采集或任意文件上传。新增来源默认暂停，启用后按频率自动同步；「手动」、空值及未知频率不自动调度，仍可显式执行同步。
- 自动删除/撤稿失效尚未实现：nyzdata 的权威删除语义尚未确认，这是自动失效的前置阻塞。列表缺席、总数减少、404、权限问题或接口错误均不会自动使本地内容退出检索，已撤回的知识可能继续被使用；确认后需管理员人工处理。
- 「知识库」目前是召回参数和回答提示词配置，不是独立语料或权限隔离空间。限定来源使用 `filters.sourceId` 等筛选条件。
- 多轮生成最多使用最近 3 轮历史，每轮历史回答最多 500 字。追问时由改写模型（未配置则用 Chat 模型）结合历史把问题改写为独立问题再检索，超时 8 秒；改写失败、超时或输出不合格时用原问题检索，回答仍基于原问题与历史。
- 微信小程序（`apps/weixin`）目前只有 uni-app 模板页面，尚未接入 API，不在 `pnpm build` / `typecheck` / `test` 覆盖范围内，计划见[微信小程序开发计划](docs/weixin-miniprogram-plan.md)。
- 生产默认使用结构化切片规则的修订版 3；父子块切片与章节上下文组装仍用于评估实验，未作为默认问答路径上线。

## 环境要求

- Node.js 24，和 Docker 构建镜像保持一致。
- pnpm 12.11.2，版本固定在根 `package.json` 的 `packageManager`。
- PostgreSQL 18 + pgvector、Redis 8。
- 使用容器部署时需要 Docker Compose v2；PostgreSQL 与 Redis 不由本项目 Compose 管理，本地使用共用基础设施（见下文）。
- 开发微信小程序需要微信开发者工具。

## 启动与配置

以下命令均在仓库根目录执行。先准备数据库和根目录 `.env`，再选择 Docker 或本机进程启动，勿同时运行两套应用。

### 1. 准备数据库和 Redis

本地开发使用本机共用的基础设施 `D:/baolf/infra`（独立的 Compose 项目，不属于任何项目，agent-template、booth-ai 与本项目共用；线上对应 1Panel 中的 PostgreSQL 与 Redis，见[部署手册](docs/deploy-1panel.md)）：

- PostgreSQL（`pgvector/pgvector:pg18`）：`localhost:5432`，容器 `infra-postgres`。本项目只使用 `nyzrag` 数据库与同名非超级用户账号。
- Redis（`redis:8-alpine`，有密码，`noeviction`）：`localhost:6379`，容器 `infra-redis`。本项目使用逻辑库 `1`（`REDIS_URL` 末尾的 `/1`），键另带 `DOCUMENT_QUEUE_NAME` 前缀。
- 本项目 Compose 不管理这两个服务，不要停止或改动它们。禁止对共用 Redis 执行 `FLUSHALL`；`FLUSHDB` 也只能在确认是本项目的逻辑库时执行。

启动基础设施（在 `D:/baolf/infra` 中执行，首次先按其 `README.md` 生成 `.env`）：

```sh
docker compose up -d --wait
```

在新的共用实例上首次接入时，用超级用户 `postgres` 执行以下 SQL（替换实际密码），账号和数据库只创建一次：

```sql
CREATE ROLE nyzrag LOGIN PASSWORD 'replace-with-a-local-password';
CREATE DATABASE nyzrag OWNER nyzrag;
REVOKE ALL ON DATABASE nyzrag FROM PUBLIC;
\c nyzrag
CREATE EXTENSION IF NOT EXISTS vector;
```

pgvector 不是受信任扩展，必须由超级用户创建；应用账号无需超级用户权限，API 和 Worker 启动时会自动迁移建表。连接串中的特殊密码字符需要 URL 编码。

### 2. 初始化环境变量

仅在没有 `.env` 时复制模板，已有文件不要覆盖。PowerShell 示例：

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

将生成值填入 `NYZ_SECRET_KEY`，并填写以下配置。完整变量和默认值见 [`.env.example`](.env.example)。

| 配置 | 用途与注意事项 |
| --- | --- |
| `DATABASE_URL`、`REDIS_URL` | 共用基础设施中本项目的库与 Redis 逻辑库：`postgresql://nyzrag:<密码>@localhost:5432/nyzrag`、`redis://:<infra 的 Redis 密码>@localhost:6379/1` |
| `DOCUMENT_QUEUE_NAME` | API 与 Worker 必须一致；模板与 Compose 默认配置为 `nyz-rag-document-processing`，本机开发也应显式设置，不依赖源码回退值 |
| `NYZ_SECRET_KEY` | API 与 Worker 必须相同，至少 32 字符；用于 AES-256-GCM 加密后台保存的模型密钥和文章 token，变更后需重新填写这些秘密；不在数据库备份中，须与备份分开单独留存（见[备份与恢复](docs/backup-restore.md)） |
| `ADMIN_EMAIL`、`ADMIN_USERNAME`、`ADMIN_PASSWORD` | 初始超级管理员邮箱、昵称/兼容登录别名、16-1024 字符密码；仅在数据库没有任何管理员时创建账号 |
| `API_PORT`、`WEB_PORT`、`ADMIN_PORT` | 模板默认 3010、5010、5011 |
| `VITE_API_URL` | 本机开发的浏览器 API 地址，默认 `http://localhost:3010`；Docker 构建固定使用同源 `/api/` |
| `ADMIN_ORIGINS`、`WEB_ORIGINS` | 允许携带 Cookie 的精确前端来源，逗号分隔，不含路径；生产环境填实际 HTTPS 来源 |
| `ADMIN_COOKIE_SECURE`、`USER_COOKIE_SECURE` | 模板的 `false` 仅供本地 HTTP；HTTPS 部署设为 `true`，前端与 API 使用相同主机以保持 Cookie 行为 |
| `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USER`、`SMTP_PASSWORD`、`MAIL_FROM` | 注册与找回密码邮件；配置 SMTP 时 `MAIL_FROM` 必填，显式设置 `SMTP_SECURE` 时必须为 `true` 或 `false` |
| `NYZ_MODEL_CREDENTIAL_ENVS` | 允许模型供应商引用的密钥环境变量名白名单，逗号分隔；API 与 Worker 配置一致 |
| `TRUSTED_PROXIES` | 可信反向代理的明确 IP/CIDR；默认不信任转发头，不可信任 `0.0.0.0/0` 或 `::/0` |

API、Worker 及两个 Vite 应用的本机开发脚本均读取根 `.env`。前端只向浏览器暴露 `VITE_` 前缀变量，数据库密码、模型密钥和主密钥不要使用此前缀。

管理员账号持久化在数据库中，后续修改 `ADMIN_PASSWORD` 不会重置已有账号密码，应在后台「个人资料」修改。普通管理员由超级管理员创建并分配角色；管理员停用或改密会使旧登录失效。

未配置 `SMTP_HOST` 时，非生产 API 将邮件内容写入日志，生产 API 的注册/找回密码发码接口返回 503。**Docker 后端固定运行在生产模式**，因此容器内调试注册也需要 SMTP；已有账号登录与匿名问答不依赖发信。

配置 `SMTP_HOST` 后，必须将模板中的 `SMTP_SECURE=` 改为 `true` / `false`，或删除/注释该变量，保留空值会导致 API 启动失败。仅在变量未定义时，端口 465 自动启用隐式 TLS，其他端口在服务器支持时使用 STARTTLS。

### 3. 启动应用

#### Docker 应用分组（推荐）

```sh
docker compose up -d --build --wait
docker compose ps
```

Docker Desktop 显示独立 `nyz-rag` 分组，默认只启动 `api`、`worker`、`web`、`admin`：

| 入口 | 默认地址 |
| --- | --- |
| 用户端 | http://localhost:5010 |
| 管理后台 | http://localhost:5011 |
| API 存活检查 | http://localhost:3010/health |
| API 就绪检查 | http://localhost:3010/ready |

- 根 `Dockerfile` 统一构建应用；修改代码后重新执行构建启动命令。端口只发布到 `127.0.0.1`。
- `.env` 只注入后端运行时，不进入镜像。启动器将连接串中的 `localhost` / `127.0.0.1` / `::1` 改写为 `host.docker.internal`，非本机地址不变。
- 管理端配置的本机模型/代理地址同样通过 `NYZ_LOOPBACK_HOST` 处理，填写 `http://127.0.0.1:<端口>/v1` 即可。不要将持久化地址写为 `host.docker.internal`，以免宿主机命令行无法访问仅监听回环地址的服务。
- 前端 Nginx 提供静态产物，将 `/api/` 同源代理至 `api:3000`，不使用本机 `VITE_API_URL`。应用容器不挂载文章数据目录，持久数据在 PostgreSQL 中。
- `/health` 只表示 API 进程存活；`/ready` 检查数据库与 Redis（2 秒超时，失败返回 503 并只写出失败项名称），Compose 的 API 健康检查用后者。Worker 的投递器每轮成功后写心跳文件（`NYZ_WORKER_HEARTBEAT_FILE`，默认在系统临时目录），健康检查 `node apps/worker/dist/healthcheck.js` 判断 30 秒内是否有心跳。两者都不能证明模型或完整处理链路正常，仍需通过实际文章任务验证。

常用管理命令：

```sh
docker compose logs -f api worker
docker compose stop
docker compose down
```

`Ctrl+C` 仅结束日志查看。`stop` 停止本项目应用，`down` 移除应用容器，均不影响共用的 PostgreSQL 与 Redis。

#### 本机进程开发

先停止容器应用，避免端口冲突，尤其不要让本机与容器 Worker 消费同一队列：

```sh
docker compose stop api worker web admin
pnpm install
pnpm dev
```

`pnpm dev` 先构建 `packages/processing`，然后启动 API、web、Worker 和微信小程序编译监听，**不包含管理后台**。另开终端运行：

```sh
pnpm --filter @nyz-rag/admin dev
```

默认访问地址与 Docker 相同。API 和 Worker 使用 `tsx watch`，两个前端使用 Vite。

微信小程序首次编译完成后，在微信开发者工具中导入 `apps/weixin/dist/dev/mp-weixin`，并在 `apps/weixin/src/manifest.json` 的 `mp-weixin.appid` 中配置自己的小程序 AppID。小程序编译监听也可单独启动：

```sh
pnpm --filter @nyz-rag/weixin dev
```

微信小程序不提供浏览器访问端口，也不随 Docker Compose 启动。

## 首次使用

1. 使用 `.env` 初始化的管理员邮箱和密码登录后台；在「模型配置」添加供应商并测试连接。
2. 为业务模型分别指定 Chat、Embedding，可选 Rerank、审核和改写模型；不同用途可以来自不同供应商。
3. 在数据源页设置全局「nyzdata 接口 Token」，新增「文章 API」来源，启用后执行同步。
4. 在文档管理确认解析、切片和向量化状态；在「知识库」配置召回参数、回答提示词、是否重排序和是否启用引用校验。
5. 打开用户端提问，核对回答、引用与文章详情；在后台查看问答记录、问答统计、反馈和操作日志。

### 模型配置

支持硅基流动、OpenAI、本地 Ollama 和其他 OpenAI 兼容服务。供应商可保存加密 API Key，也可引用 `NYZ_MODEL_CREDENTIAL_ENVS` 白名单中的环境变量；本地模型可不填密钥。仅填写 `OPENAI_API_KEY` 不会自动创建业务模型配置。

- Chat：生成回答，可配置温度和最大 Token。
- Embedding：向量化切片、标题与摘要，以及检索问题。
- Rerank：配合知识库的重排序开关，对融合召回结果重排。
- 审核：合成评估题审核、失败题复判和回答质量评审，不是在线问答必需模型。
- 改写：把追问结合历史改写为独立的检索问题，按其温度与最大 Token 调用；未配置时用 Chat 模型（温度 0、最大 256 Token）。

被业务模型使用的供应商不能删除。**更换 Embedding 供应商或模型后，需要重新向量化文档**；向量检索只比较相同供应商、模型和维度的数据，不会跨向量空间自动兼容。

未配置可用 Chat 模型或普通模型调用失败时，可降级为原文摘录；向量和重排普通故障也有降级路径。知识库开启引用校验（默认开启）时使用严格引用提示词，回答没有引用（固定拒答除外）或含越界编号时同样改为摘录，流式输出中出现越界编号即停止。降级原因（`no_chat_model`、`no_context`、`model_error`、`citation_rejected`、`empty_answer`）只记录在问答记录中，管理端可见，不返回给用户端。限流拒绝或限流服务不可用不属于降级场景，会返回错误且不保存本轮回答。

管理端「问答统计」按浏览器时区逐日统计问答数、降级率与原因、总耗时与首 Token 的 P50/P95、Token 用量和差评数（`GET /api/admin/chat-stats?days=1..90`）。

### 文章同步与处理

来源地址填写文章列表接口，例如 `https://nyzdata.nenghe.com/nyzfoxx/article?tagKey=9302258412`。地址中不要携带 token；后台 token 加密保存，所有来源共用，Worker 每次同步读取，更新后无需重启。

- 依据文章 `updateTime` 增量同步，达到单次上限后再次同步继续；失败文章在后续同步中重试。
- Worker 启动后及每 30 秒检查到期来源，识别「每小时 / 每 6 小时 / 每天」。首次启用且从未同步的来源立即到期；后续以最近任务创建时间与最近成功完成时间中的较晚者为基准。失败尝试也占用周期，错误凭据不会每次轮询都产生新失败任务；长时间失败在周期已过时可于下次轮询重试。停机错过的周期只补一个任务，不逐个补跑。
- 调度重新在数据库行锁内检查启停、频率和到期时间，与任务及 outbox 在同一事务内提交；多 Worker、手动同步与自动调度通过现有唯一索引互斥。暂停停止新增自动任务，不取消已经排队或执行中的任务；启用「手动」来源不自动执行。手动同步同样重置下一次自动调度周期。
- 完成首次回填后，每 7 天在后续同步中启动一次全量详情巡检；升级前已完成回填但没有巡检时间的来源会在下次同步启动巡检。「手动」来源仍需手动触发后续批次。巡检绕过连续静默页停止条件，对列表中的全部文章重新请求详情，包括缺少或未改变 `updateTime` 的文章，以覆盖深处历史修订。
- 全量巡检按单次文章预算分批，持久化页码及页内已尝试的 key，后续任务/重启继续；每篇尝试和每页完成均保存断点。普通详情失败保留重试 key 并继续，权限等 fatal 错误或列表请求错误中止且不标记巡检完成；失败重试不抢占巡检的前进预算。巡检完成时间只表示遍历结束，不表示每篇详情都成功，也不是删除确认。待重试 key 最多保留 500 个，超出部分需后续巡检再次发现。
- 巡检使用上游分页而非一致性快照，巡检期间列表重排仍可能导致遗漏或重复，不能保证某个时刻的严格全量覆盖。全量刷新会重新解析/切片并可能产生向量化调用费用；普通增量阶段仍依赖 `updateTime`，无时间戳的已知文章由全量巡检刷新。
- `NYZ_ARTICLE_SYNC_LIMIT` 默认 200；`NYZ_ARTICLE_OVERLAP_PAGES` 默认 2；请求间隔和超时由 `NYZ_ARTICLE_REQUEST_DELAY_MS` / `NYZ_ARTICLE_REQUEST_TIMEOUT_MS` 控制，默认 1000/15000 毫秒。
- 原始文章保存在 `documents.raw_json`。解析规则升级后执行「重新处理」，无需重新请求文章接口；切片和向量化是独立状态，向量化失败可单独重试。
- 正文重复文章保留来源和文档记录，但不独立切片、向量化或参与检索；主文档删除后会安排重复文档接替。
- 向量化暂时故障的重试延迟默认 1、5、15 分钟，可用 `NYZ_EMBED_RETRY_DELAYS_MS` 修改，显式空值关闭重试。运行租约由 `NYZ_OPERATION_LEASE_MS` 控制，默认 60 秒。

## API 与检索

用户端和管理端通过共享的 `@nyz-rag/api-client` 访问接口。直接调用时，问答、会话、反馈和用户认证的写请求需带 `X-NYZ-Client: 1`；连续会话请求必须保留服务端签发的 Cookie。管理端写请求需带 `X-NYZ-Admin: 1`，并通过管理员认证和来源校验。

| 接口 | 说明 |
| --- | --- |
| `POST /api/chat` | 单次问答，body 为 `{ "question": "...", "knowledgeBaseId": "可选ID", "filters": {} }` |
| `POST /api/chat/sessions` | 创建会话，body 可含 `title`、`knowledgeBaseId`；会话按账号或浏览器访客归属隔离 |
| `GET /api/chat/sessions` | 分页列出自己的历史会话 |
| `GET /api/chat/sessions/:id/messages` | 查看自己的会话消息 |
| `POST /api/chat/sessions/:id/stream` | SSE 问答，body 为 `{ "question": "..." }` 或 `{ "regenerate": "<最新messageId>" }`，均可加 `filters` |
| `DELETE /api/chat/sessions/:id` | 删除自己的会话 |
| `POST /api/messages/:id/feedback` | 评价自己的回答，`rating` 为 `positive` 或 `negative` |
| `POST /api/search` | 关键词搜索，body 为 `{ "query": "...", "filters": {} }`，按文章去重，最多返回 20 篇；不是混合检索 |
| `GET /api/documents/:id` | 仅返回就绪文档的公开详情；用户端引用可打开 `/#/documents/:id` |

SSE 事件为 `source`、`token`、`done`、`error`。停止生成或客户端断开会中止模型调用，不保存本轮问答；重新生成只允许替换最新回答。匿名历史依赖浏览器访客 Cookie，登录后会将该浏览器的访客会话和问答归入账号。

问答先进行 BM25/元数据、切片向量、标题与摘要向量三路召回，再通过 RRF 融合和可选重排组装上下文；追问先改写为独立问题，改写结果用于召回与重排。没有摘要的文章不生成摘要向量。召回切片、分数、改写结果、模型用量和耗时随问答记录保存。

召回数量、相似度阈值、最大上下文和回答提示词默认取最近创建的知识库；单次问答可传 `knowledgeBaseId`，SSE 则在创建会话时绑定，不通过每轮 stream body 切换。

搜索、单次问答和 SSE 均支持以下筛选：

```json
{
  "filters": {
    "publishedFrom": "2026-01-01",
    "publishedTo": "2026-10-24",
    "categories": ["科研"],
    "tags": ["钠电"],
    "scenarios": ["储能"],
    "sourceId": "<数据源ID>"
  }
}
```

日期按 UTC 整日包含首尾；列表精确匹配，列表内 OR、字段间 AND，空列表不限制。筛选仅作用于当前请求，不持久化到会话，重新生成也使用当前传入的筛选。

### 限流与部署安全

- Redis 准入控制始终启用，Redis 故障返回 503，不绕过限制。普通 HTTP 限流返回 429 和 `Retry-After`；已建立 SSE 后的模型准入故障通过 `error` 事件报告。
- 默认窗口 60 秒；API 每 IP 120 次、已登录用户 60 次；问答每 IP 20 次、每账号/访客 10 次，并发分别为 4、2，全局问答并发 32。
- 模型按供应商、模型和用途限流，默认每窗口 120 次、并发 8，API 与 Worker 共用额度；配置项为 `MODEL_RATE_LIMIT_MAX` / `MODEL_CONCURRENCY_LIMIT`。
- 对外发布需配置 HTTPS、实际前端来源、Secure Cookie、SMTP 和可信代理。Nginx 代理场景应设置实际代理地址，否则基于 IP 的限流可能将所有用户视为同一来源。
- 秘密配置接口只报告是否设置，不回传明文。不要将文章 token 或模型密钥写入 URL、源码、日志或提交。

## 开发与验证

| 命令 | 用途 |
| --- | --- |
| `pnpm dev` | 构建 processing 后启动 API、web、Worker 和微信小程序编译监听 |
| `pnpm --filter @nyz-rag/weixin dev` | 单独启动微信小程序编译监听 |
| `pnpm --filter @nyz-rag/admin dev` | 独立启动管理后台 |
| `pnpm build` | 构建所有 workspace 包 |
| `pnpm typecheck` | 先构建 processing，再检查所有包类型 |
| `pnpm test` | 先构建 processing，再串行执行各包已定义的测试 |
| `pnpm verify` | 依次执行全量构建、类型检查和测试 |
| `pnpm --filter @nyz-rag/processing test` | 文章解析、切片、检索、评估、模型及任务逻辑测试 |
| `pnpm --filter @nyz-rag/api test` | API 契约、路由 Schema、认证权限与限流测试 |
| `pnpm --filter @nyz-rag/api-client test` | 共享 HTTP/SSE 客户端测试 |
| `pnpm --filter @nyz-rag/<web\|admin> test` | 前端纯逻辑测试，以 Node 类型擦除直接运行源码 |
| `pnpm db:generate` | 根据 Drizzle Schema 生成迁移 |
| `pnpm db:migrate` | 手动执行数据库迁移 |
| `pnpm db:reindex-search` | 重建切片及文档元数据的关键词词项 |
| `pnpm db:restore-drill --dump=<备份>` | 恢复演练：把备份恢复到临时库并检查迁移、行数与密钥，结束后删除临时库 |

需要数据库、Redis 和 Worker 的集成测试默认跳过。配置好根 `.env` 的连接串后，可在 PowerShell 中启用：

```powershell
$env:NYZ_INTEGRATION_TEST = '1'
pnpm --filter @nyz-rag/processing exec tsx --env-file-if-exists=../../.env --test test/*.test.ts
Remove-Item Env:NYZ_INTEGRATION_TEST
```

集成测试使用临时 PostgreSQL schema 和唯一队列，不消费业务队列或填充业务表。测试账号需要创建 schema 的权限，数据库需已在 `public` 中安装 pgvector（否则首个迁移会把扩展建进临时 schema，并行的其他测试找不到 `vector` 类型）。直接运行 API 测试前应先构建 processing，例如执行 `pnpm --filter @nyz-rag/processing build`。

GitHub Actions（`.github/workflows/ci.yml`）在每个 PR 和推送到 main 时运行 `pnpm verify`，并用 pgvector 与 Redis 服务容器运行包含集成测试的 `pnpm test`。测试不读取 `.env`，新增依赖环境变量的测试须在测试内设置或同步到工作流。

### 数据库维护

表结构定义在 `packages/processing/src/schema.ts`，迁移位于 `packages/processing/migrations`。API 和 Worker 启动自动迁移；修改 Schema 后生成迁移，修改 `search-terms.ts` 规则后全量重建检索词项。Worker 启动会补齐缺失词项和正文指纹，并为与当前 Embedding 供应商/模型一致的旧文档补充缺失的摘要向量，后者会调用模型。

HNSW 部分表达式索引覆盖 384、512、768、1024、1536、2000 维向量，其他维度精确检索；近似召回过滤后候选不足时精确回退。大语料首次建索引可能延长启动并阻塞切片写入，宜在维护窗口先执行 `pnpm db:migrate`。迁移连接不受普通查询的 10 秒超时限制；实际速度与召回率需在目标语料上评估。

升级旧版本前先备份：迁移 `0011` 会删除网页来源、相关文档及没有原始文章 JSON 的文档；原本依赖这些主文档的重复文章会标记处理失败，需重新处理。

### 备份与恢复

用 `pg_dump --format=custom --exclude-schema='eval_*'` 整库备份业务库，并单独留存 `NYZ_SECRET_KEY`；Redis 只有队列、会话、验证码与限流计数，不需要备份。`pnpm db:restore-drill` 需另设 `NYZ_RESTORE_ADMIN_URL`（能建库并创建 `vector` 扩展的账号），不连接业务库。各表丢失后能否重建、备份命令、演练与正式恢复步骤见 [备份与恢复](docs/backup-restore.md)。

## 检索与回答评估

完整方案、指标与验收边界见 [评估方案](docs/evaluation-plan.md)。评估题是文章衍生合成题，不能直接代表真实用户效果；模型审核不能替代人工复核。

### 关键词基线

```sh
# 本地清洗样本的词项重叠基线
pnpm evaluate:retrieval --mode=offline
# 已入库文章的关键词基线，只读，不迁移或填充数据库
pnpm evaluate:retrieval --mode=db
# 指定数据集与划分
pnpm evaluate:retrieval --mode=db --dataset=<JSON路径> --split=dev
```

默认数据集为 `packages/processing/test/evaluation/retrieval-dataset.json`，包含 50 条未经过人工标注复核的合成问题。离线模式默认读取 `.nyz-data/nyz-articles/clean`（未随仓库提交），可用 `--corpus=<清洗目录>` 覆盖；数据库模式不需要本地样本。支持 `--k=1,3,5,10`，输出文章去重后的 Recall@K、MRR、线性增益 nDCG@K。

数据库模式只取前 `max(20,K)` 个切片再按文章去重，不是全库文章级排序。有缺失标注文章时报告覆盖缺口并返回非零退出码，不能将部分语料指标当完整基线。上述两种模式不评估向量、重排或回答质量。

### 混合检索与回答

```sh
# 关键词、切片向量、摘要向量、融合与重排消融；默认使用最近创建的知识库参数
pnpm evaluate:retrieval --mode=hybrid --dataset=<JSON路径> --name=baseline --split=dev --variant=keyword,vector,summary,fused,rerank
# 对比两次检索运行，运行名取该名称最新记录，也可传记录路径
pnpm evaluate:compare baseline candidate
# 用审核模型复判失败题；--dry-run 只统计待判文章
pnpm evaluate:adjudicate baseline --variant=fused,rerank --dry-run
# Chat 生成回答并由审核模型评审，不保存业务问答记录
pnpm evaluate:answer --dataset=<JSON路径> --name=answer-baseline --split=dev --variant=fused --context=topk
```

非关键词变体要求可用 Embedding，`rerank` 变体额外要求 Rerank；回答评估和实际复判需要审核模型。支持用 `--limit=N` 冒烟验证，但该结果不作为完整基线。混合检索报告 Hit@K、MRR、证据/上下文命中和耗时等，运行记录写入 `.nyz-data/eval-runs/`；回答结果位于 `.nyz-data/eval-answers/`，复判缓存位于 `.nyz-data/eval-adjudications/`。模型相关命令会产生费用，并与线上任务共享模型准入额度。

### 多轮追问评估

```sh
# 从已冻结的单轮合成集派生追问题，并配对同等数量的换话题题；先用 --limit 试点
pnpm evaluate:multiturn --name=nyz-rag-multiturn-v1 --from=packages/processing/test/evaluation/nyz-rag-synthetic-v1.json --split=dev --limit=30
# 去掉 --limit 继续全部题目，完成后导出
pnpm evaluate:multiturn --name=nyz-rag-multiturn-v1
pnpm evaluate:multiturn --name=nyz-rag-multiturn-v1 --freeze
# 含历史的题目必须指定改写方式：none、concat、llm（与问答共用改写模型）、standalone
pnpm evaluate:retrieval --mode=hybrid --dataset=packages/processing/test/evaluation/nyz-rag-multiturn-v1.json --rewrite=llm --name=mt-llm
```

追问题由 Chat 模型生成、审核模型审核，会产生费用，工作目录同样在 `.nyz-data/evaluation/<名称>/`，可断点续跑。`evaluate:answer` 遇到带历史的题目同样必须指定 `--rewrite`；指标另按对话轮次分组。详见评估方案第 8.10 节。

### 合成数据集与实验索引

```sh
# 首次冻结语料快照并分层抽样，默认 400 篇、种子 20261023；仅处理前 50 篇试点
pnpm evaluate:generate --name=nyz-rag-synthetic-v1 --limit=50 --concurrency=3
# 去掉 --limit 继续全部样本；完成后导出 schemaVersion 2 数据集
pnpm evaluate:generate --name=nyz-rag-synthetic-v1 --concurrency=3
pnpm evaluate:generate --name=nyz-rag-synthetic-v1 --freeze
# 建立父子块实验索引，写入独立 schema 并调用 Embedding，不修改业务 schema
pnpm evaluate:index --schema=eval_sections --chunker=2 --concurrency=4
# 使用实验索引和章节上下文进行消融
pnpm evaluate:retrieval --mode=hybrid --dataset=<JSON路径> --name=sections --schema=eval_sections --context=section --variant=fused,rerank
```

合成题使用 Chat 生成问题、参考答案和证据，经程序校验与审核模型审核，未通过时最多尝试 3 次；工作目录为 `.nyz-data/evaluation/<名称>/`，中断后重跑继续未完成文章，导出默认写入 `packages/processing/test/evaluation/<名称>.json`。此流程不修改业务数据库，但会调用模型并写本地文件。

实验索引不是只读操作：它在同一数据库创建 `eval_*` schema，执行迁移并复制文章、来源、知识库及模型配置（含加密密钥），重新切片和向量化。重复运行可续跑，`--reset` 会删除并重建指定实验 schema；需要相应建表权限、磁盘空间和费用预算。

## 生产部署

生产环境为 1Panel 服务器，不在服务器上构建：本地用 `scripts/package-images.ps1` 构建并导出镜像到 `release/`，上传导入后用 `deploy/compose.yml`（只含 api、worker、web、admin，各容器有内存上限）启动。PostgreSQL（`pgvector/pgvector:pg18`）与 Redis 使用 1Panel 应用商店中各项目共用的实例，api 与 worker 加入 `1panel-network`，连接串写在服务器 `.env`（模板 [`deploy/.env.example`](deploy/.env.example)），约定与本地共用基础设施相同。服务器拉不到 pgvector 镜像时，打包脚本加 `-IncludePgvector` 一并导出。完整步骤（建库、OpenResty 网站、验证、发布与回滚、备份）见 [1Panel 部署手册](docs/deploy-1panel.md)。

## 代码结构

| 路径 | 职责 |
| --- | --- |
| `apps/web` | Vue 3 + Vite 用户端 |
| `apps/admin` | Vue 3 + Vue Router + Vite 管理后台 |
| `apps/api` | Fastify 分域插件、JSON Schema、认证权限、限流和 SSE |
| `apps/worker` | BullMQ 消费、文章同步、重新处理、向量化和操作恢复 |
| `apps/weixin` | uni-app 微信小程序（开发中，不参与 Docker 构建） |
| `packages/types` | 前后端共享接口类型，包名 `@nyz-rag/types` |
| `packages/api-client` | 前端共享 fetch/SSE 客户端 |
| `packages/ui` | 共享 Vue UI 组件、确认弹窗与主题样式 |
| `packages/processing` | Drizzle 数据访问、文章解析/切片、去重、模型接口、检索与评估 |
| `docker` | 后端启动地址改写和前端 Nginx 配置 |
| `deploy` | 1Panel 生产编排与环境变量模板 |
| `scripts` | 镜像打包脚本、文章解析原型 |

API 入口通过 `apps/api/src/app.ts` 装配领域插件。每条路由必须在 `apps/api/src/schemas.ts` 中注册请求/响应 Schema，响应 Schema 会移除未声明字段；错误响应统一为 `{ "error": "..." }`。

相关设计资料：[系统架构](docs/rag-system-architecture.md)、[切片设计](docs/chunking-design.md)、[评估方案](docs/evaluation-plan.md)、[模块清单](docs/module-status.md)、[1Panel 部署手册](docs/deploy-1panel.md)、[备份与恢复](docs/backup-restore.md)、[微信小程序开发计划](docs/weixin-miniprogram-plan.md)。设计与进度文档可能包含规划内容，当前能力以源码及上述边界为准。
