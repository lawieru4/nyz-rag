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

当前问答接口是连通性占位实现；模型调用、检索链路、数据库 schema 和文章同步任务仍需后续开发。

## Workspace

- `apps/web`：Vue 3 + Vite 用户端
- `apps/api`：Fastify HTTP API
- `apps/worker`：BullMQ 文档处理队列消费者
- `packages/types`：前后端共享接口类型
