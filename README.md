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
- `.env` 只注入后端运行时，不进入镜像。后端启动器将连接串中的 `localhost` / `127.0.0.1` / `::1` 转为 `host.docker.internal`，通过宿主机端口连接已有服务；非本机地址保持不变。
- 前端使用 Nginx 提供构建产物并将 `/api/` 代理到 API，浏览器不依赖容器 DNS，也不需要在镜像中配置宿主机 API 地址。Docker 构建固定使用同源 API，不使用本机的 `VITE_API_URL`。
- 元数据与向量都存于 `DATABASE_URL` 指向的 PostgreSQL，容器不挂载数据目录；API 和 Worker 启动时自动执行数据库迁移。不要同时启动本机 Worker 和容器 Worker 消费同一队列。
- 仅将端口暴露到 `127.0.0.1`。当前管理 API 没有认证，不应直接开放到公网。
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
- API 问答入口：`POST http://localhost:3001/api/chat`，JSON body 为 `{ "question": "..." }`

当前问答接口使用关键词召回与文章片段拼接。网页采集、清洗切片和 Embedding/pgvector 写入已接通；混合检索、Rerank 和真实模型问答尚待开发，模块进度见 [模块清单](docs/module-status.md)。

API、Worker、web 和 admin 均读取根目录 `.env`。前端只向浏览器暴露 `VITE_` 前缀变量，不要给数据库密码或模型密钥添加此前缀。使用向量化时，在 `.env` 中设置模型密钥和 `DATABASE_URL`，并在管理后台配置默认、启用的 OpenAI 兼容供应商及 Embedding 模型。

元数据与向量都存于 PostgreSQL，表结构用 Drizzle ORM 定义在 `packages/processing/src/schema.ts`。修改后运行 `pnpm db:generate` 生成迁移；API 和 Worker 启动时自动执行迁移，也可手动运行 `pnpm db:migrate`。从旧版 JSON 快照升级时执行一次 `pnpm db:import-snapshot [快照绝对路径]`（默认读取 `NYZ_STORE_PATH` 或 `.nyz-data/knowledge.json`），会同时迁移旧 `document_vectors` 表中的向量；可重复执行，已存在的记录会跳过。确认无误后可由管理员删除 `document_vectors` 表。

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
- `packages/processing`：Embedding、pgvector 与 API/Worker 共用的原子元数据存储
