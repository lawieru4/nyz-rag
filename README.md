# NYZ RAG

NYZ 文章问答系统的 pnpm monorepo 初始骨架，采用 Vue 客户端、Fastify API、BullMQ Worker 和 PostgreSQL/pgvector。

## 环境要求

- Node.js 22 或更高版本
- pnpm 10 或更高版本
- Docker Compose（用于本地 PostgreSQL 和 Redis）

## 本地开发

```sh
cp .env.example .env
docker compose up -d
pnpm install
pnpm dev
```

- 客户端：http://localhost:5173
- API 健康检查：http://localhost:3000/health
- API 问答入口：`POST http://localhost:3000/api/chat`，JSON body 为 `{ "question": "..." }`

当前问答接口使用关键词召回与文章片段拼接。网页采集、清洗切片和 Embedding/pgvector 写入已接通；混合检索、Rerank 和真实模型问答尚待开发，模块进度见 [模块清单](docs/module-status.md)。

API 和 Worker 的启动命令会加载根目录 `.env`。使用向量化时，在 `.env` 中设置模型密钥和 `DATABASE_URL`，并在管理后台配置默认、启用的 OpenAI 兼容供应商及 Embedding 模型。首次写入会创建 `vector` 扩展与 `document_vectors` 表。元数据仍存于 `.nyz-data/knowledge.json`，向量单独存入 PostgreSQL。

## Workspace

- `apps/web`：Vue 3 + Vite 用户端
- `apps/admin`：Vue 3 + Vite 管理后台，运行 `pnpm --filter @nyz-rag/admin dev`
- `apps/api`：Fastify HTTP API
- `apps/worker`：BullMQ 文档处理队列消费者
- `packages/types`：前后端共享接口类型
- `packages/processing`：Embedding、pgvector 与 API/Worker 共用的原子元数据存储
