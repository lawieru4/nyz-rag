# NYZ RAG 文章问答系统技术方案

## 一、总体推荐

### 推荐技术栈

| 模块 | 推荐技术 |
| --- | --- |
| 客户端 | Vue 3 + Vite + TypeScript + Pinia + Vue Router |
| 管理后台 | Vue 3 + Element Plus + TypeScript |
| 服务端 | Node.js + NestJS + Fastify Adapter |
| ORM | Prisma 或 Drizzle |
| 主数据库 | PostgreSQL |
| 向量数据库 | PostgreSQL + pgvector |
| 缓存 | Redis |
| 队列任务 | BullMQ + Redis |
| 文件存储 | MinIO / S3 / OSS |
| 内容抓取 | Crawlee 或 Playwright |
| HTML 解析 | Cheerio + Mozilla Readability |
| Embedding | 智谱、阿里百炼、OpenAI、硅基流动或本地模型 |
| 重排序 | BGE Reranker / 云端 Rerank API |
| LLM | Qwen、DeepSeek、GLM、OpenAI 等 |
| 部署 | Docker Compose 起步，后续 Kubernetes |
| 监控 | Prometheus + Grafana + Loki/Sentry |
| Monorepo | pnpm workspace + Turborepo |

### 核心原则

第一版不要急着引入独立向量数据库、微服务、Kubernetes。PostgreSQL + pgvector + Redis 已经足够完成一个中小规模的文章型 RAG 系统。

## 二、推荐系统架构

```text
                         ┌──────────────┐
                         │   Vue 客户端  │
                         │ 文章问答/搜索 │
                         └──────┬───────┘
                                │ HTTPS
                         ┌──────▼───────┐
                         │ API 服务      │
                         │ NestJS       │
                         └──────┬───────┘
                ┌───────────────┼────────────────┐
                │               │                │
        ┌───────▼───────┐ ┌─────▼─────┐  ┌───────▼───────┐
        │ PostgreSQL     │ │ Redis     │  │ LLM/Embedding │
        │ 业务+向量数据  │ │ Cache队列 │  │ 模型服务       │
        └───────────────┘ └─────┬─────┘  └───────────────┘
                                │
                         ┌──────▼───────┐
                         │ Worker       │
                         │ API抓取/解析/向量 │
                         └──────┬───────┘
                                │
                         ┌──────▼───────┐
                         │ 目标网站      │
                         │ nyz.nenghe.com│
                         └──────────────┘
```

系统可以拆成以下逻辑模块：

1. 用户端问答与检索
2. 管理后台
3. 内容采集
4. 内容清洗
5. 文档切片
6. 向量化
7. 混合检索
8. RAG 问答
9. 用户、权限、反馈和运营数据

## 三、客户端技术选型

### 1. 基础技术

推荐：

- Vue 3
- Vite
- TypeScript
- Vue Router
- Pinia
- Axios 或 ofetch
- SSE
- Tailwind CSS 或 UnoCSS

如果是偏产品化的客户端，可以使用：

- Vue 3
- Vite
- TypeScript
- Tailwind CSS
- Radix Vue 或 Naive UI

如果希望快速开发：

- Vue 3
- Vite
- TypeScript
- Element Plus
- Pinia
- VueUse

### 2. 客户端核心功能

建议第一版包含：

#### 问答页面

- 对话式提问
- 流式输出
- 引用来源展示
- 来源文章标题、摘要、链接
- 重新生成
- 复制回答
- 点赞/点踩
- 用户反馈

#### 搜索页面

- 关键词搜索
- 语义搜索
- 分类筛选
- 时间筛选
- 来源筛选
- 分页
- 高亮命中片段

#### 文章页面

- 文章标题
- 原始来源链接
- 发布时间
- 正文内容
- 相关文章
- “基于此文章提问”

#### 用户中心

- 登录注册
- 历史问答
- 收藏
- 反馈记录

### 3. 流式问答协议

问答接口建议使用 SSE：

```http
GET /api/chat/stream?conversationId=xxx&question=xxx
```

返回事件：

```text
event: token
data: {"content":"这是"}

event: token
data: {"content":"一段回答"}

event: source
data: {"documentId":"xxx","title":"文章标题","url":"..."}

event: done
data: {"messageId":"xxx"}
```

相比 WebSocket，SSE 更适合单向的 LLM 流式输出，开发和部署也更简单。

## 四、管理后台技术选型

管理后台建议单独作为一个前端应用，不要和用户端完全混在一起。

### 推荐技术

- Vue 3
- Vite
- TypeScript
- Element Plus
- Pinia
- ECharts
- Vue Router

### 管理后台主要模块

#### 1. 数据源管理

- 添加网站地址
- 配置抓取规则
- 设置抓取频率
- 配置最大抓取页数
- 配置请求间隔
- 查看 robots.txt
- 手动开始抓取
- 暂停抓取

采集 `nyz.nenghe.com` 之前，应确认网站授权、robots.txt 和站点使用协议，控制抓取频率，避免对网站造成压力。

#### 2. 文档管理

- 文档列表
- 文档详情
- 原始 HTML
- 清洗后的正文
- 文档状态
- 文档分类
- 发布时间
- 文章标签
- 向量化状态
- 重新处理
- 删除文档
- 查看文章版本

#### 3. 知识库管理

- 新建知识库
- 配置知识库描述
- 设置召回数量
- 设置相似度阈值
- 设置重排序开关
- 设置上下文最大长度
- 配置回答提示词
- 配置模型

#### 4. 问答管理

- 会话列表
- 用户提问
- 模型回答
- 引用来源
- 召回片段
- 检索耗时
- 首 Token 耗时
- 总耗时
- 用户评价

#### 5. 模型配置

不要把模型配置写死在代码中，而是通过后台配置：

- Embedding 模型
- Chat 模型
- Rerank 模型
- 温度
- 最大 Token
- Top K
- 相似度阈值

不同模型可以配置为：

- Embedding：bge-m3
- Chat：Qwen2.5 / Qwen3 / DeepSeek / GLM
- Rerank：bge-reranker-v2-m3

## 五、服务端技术选型

推荐使用 NestJS。其优势包括：

- 模块化结构清晰
- 适合用户、权限、知识库、文档等复杂业务
- TypeScript 支持完善
- 有 Guard、Interceptor、Pipe、Decorator
- 适合后期拆分 Worker
- 生态中间件较成熟

建议使用：

- NestJS
- Fastify
- TypeScript
- Prisma 或 Drizzle
- Zod
- Pino
- BullMQ

### NestJS 模块划分

```text
src/
├── auth/
├── users/
├── roles/
├── permissions/
├── knowledge-bases/
├── data-sources/
├── documents/
├── document-processing/
├── crawling/
├── retrieval/
├── chat/
├── conversations/
├── feedback/
├── model-providers/
├── system-config/
├── audit-logs/
└── common/
```

### 主要接口示例

#### 用户端

```text
POST /api/auth/login
GET  /api/user/profile

POST /api/chat/sessions
GET  /api/chat/sessions
GET  /api/chat/sessions/:id/messages
GET  /api/chat/sessions/:id/stream

POST /api/search
GET  /api/documents/:id
POST /api/messages/:id/feedback
```

#### 管理端

```text
GET    /api/admin/documents
POST   /api/admin/documents/:id/reprocess
DELETE /api/admin/documents/:id

GET    /api/admin/crawl-tasks
POST   /api/admin/crawl-tasks
POST   /api/admin/crawl-tasks/:id/run

GET    /api/admin/knowledge-bases
POST   /api/admin/knowledge-bases
PATCH  /api/admin/knowledge-bases/:id

GET    /api/admin/chat-logs
GET    /api/admin/system-stats
```

## 六、PostgreSQL 与向量数据库选择

### 第一阶段：PostgreSQL + pgvector

强烈建议先使用 PostgreSQL + pgvector。文档切片表中保存向量：

```sql
CREATE EXTENSION vector;

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY,
  document_id UUID NOT NULL,
  content TEXT NOT NULL,
  content_hash VARCHAR(64),
  chunk_index INTEGER NOT NULL,
  token_count INTEGER,
  embedding vector(1024),
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);
```

具体向量维度要根据 Embedding 模型决定，例如：

- BGE-M3：通常是 1024 维
- text-embedding-3-small：1536 维
- text-embedding-3-large：3072 维

不要在代码中随意写死，最好根据模型配置决定。

### pgvector 索引

数据量较小时可以使用：

```sql
CREATE INDEX document_chunks_embedding_idx
ON document_chunks
USING hnsw (embedding vector_cosine_ops);
```

一般来说：

- 10 万以内切片：PostgreSQL + pgvector 很合适
- 100 万以内切片：仍可使用，但需要优化硬件和索引
- 更大规模：再考虑 Milvus、Qdrant、Elasticsearch/OpenSearch

### 什么时候引入 Qdrant

如果后续出现以下情况，再考虑 Qdrant：

- 向量数据达到数百万级
- 检索延迟要求较高
- 需要大量向量过滤
- 向量数据与业务数据库完全分离
- 需要独立扩容向量检索服务

初期不建议直接上 Qdrant 或 Milvus，会增加部署、备份和数据一致性复杂度。

## 七、Redis 的使用方式

Redis 不仅用于缓存，建议承担以下职责。

### 1. 缓存

- 热门问题答案
- 文档详情
- 知识库配置
- 用户会话
- 限流计数

### 2. BullMQ 队列

将耗时任务放入异步队列：

- fetch-article-api
- parse-prosemirror
- normalize-document
- split-document
- generate-embedding
- index-document
- sync-article-assets
- delete-document
- rebuild-knowledge-base

处理流程：

```text
管理后台点击“开始同步”
        ↓
API 创建任务
        ↓
BullMQ 写入 Redis
        ↓
Worker 消费任务
        ↓
调用文章详情 API
        ↓
保存原始 JSON
        ↓
解析 ProseMirror/Tiptap
        ↓
生成 Markdown、纯文本和结构化块
        ↓
切片、向量化、索引
        ↓
更新文档状态
```

### 3. 分布式锁

防止同一篇文章被多个任务重复同步：

- `article-sync-lock:{articleKey}`
- `document-lock:{documentId}`

### 4. 限流

可以使用 Redis 实现：

- IP 限流
- 用户限流
- 每日问答额度
- 爬虫请求频率限制
- 模型接口限流

## 八、网页内容采集方案

针对 `nyzdata.nenghe.com`，应优先使用 HTTP API 客户端直接获取文章详情，再将 ProseMirror/Tiptap JSON 转换为标准化 Markdown 和纯文本。Crawlee、Playwright、Cheerio 和 Readability 作为网页型数据源的通用备用方案，不应作为该接口的主解析路径。

文章详情接口示例：

```http
GET /nyzfoxx/article/articleDetail?token={token}&articleKey={articleKey}
```

接口返回的核心正文位于 `data.content`，其结构通常为：

```json
{
  "type": "doc",
  "content": [
    {
      "type": "heading",
      "attrs": { "level": 2 },
      "content": [{ "type": "text", "text": "章节标题" }]
    },
    {
      "type": "paragraph",
      "content": [{ "type": "text", "text": "正文内容" }]
    },
    {
      "type": "image",
      "attrs": { "src": "https://cdn-nyz.nenghe.com/image.png" }
    }
  ]
}
```

### 采集流程

```text
读取数据源配置
  ↓
校验 token、articleKey 和访问授权
  ↓
调用文章详情 API
  ↓
校验响应状态和 data.content 结构
  ↓
保存原始 API JSON
  ↓
解析 ProseMirror/Tiptap 节点
  ↓
生成 Markdown、纯文本和结构化块
  ↓
处理图片、附件和链接资源
  ↓
生成内容 hash 并判断版本变化
  ↓
保存文档与文档版本
```

### ProseMirror/Tiptap 解析规则

解析器建议单独封装为纯函数，并使用 `type` 分发节点处理逻辑。至少应支持：

- `doc`：递归遍历子节点
- `paragraph`：输出段落文本
- `heading`：转换为 Markdown 标题，并记录标题层级
- `blockquote`：转换为引用块
- `bulletList`、`orderedList`、`listItem`：保留列表结构
- `codeBlock`：保留代码语言和代码内容
- `horizontalRule`：转换为分隔线
- `image`：提取 `src`、`alt`、`title`、尺寸和对齐信息
- `hardBreak`：转换为换行
- `text`：保留文本及粗体、斜体、链接、代码等 marks
- `wrapDiv`：保留必要的布局语义，忽略无业务价值的 HTML class

解析时需要同时生成三种结果：

1. `content_json`：完整原始 ProseMirror/Tiptap JSON，用于重新解析
2. `markdown`：用于展示、导出和后续切片
3. `plain_text`：用于全文检索、去重和 Embedding 预处理

解析器必须具备容错能力：未知节点不能导致整篇文章失败，应记录 `unknown_node_types` 并继续处理；缺少 `content` 的空节点、非法图片 URL 和异常 marks 也应被安全跳过。

### 媒体和附件处理

- 图片不要直接拼进正文文本，应单独保存资源 URL、alt、标题和出现顺序
- 附件应保存原始文件名、存储 key、下载权限和下载状态
- 默认只对正文文本进行 Embedding，图片和 PDF 附件通过独立任务处理
- 如果下载远程图片或附件，应设置超时、大小限制、MIME 校验和域名白名单

### 采集数据建议

保存以下字段：

- url
- canonical_url
- title
- author
- category
- tags
- published_at
- updated_at
- cover_url
- raw_html（网页型数据源可选）
- raw_json
- content_json
- markdown
- plain_text
- clean_content
- content_hash
- source_format
- parser_version
- parse_status
- parse_error
- source_name
- crawl_status
- last_crawled_at
- last_synced_at
- source_article_key

同时建议保存原始 API JSON，方便后续升级解析器后重新生成 Markdown、纯文本和切片。`parser_version` 变化时，可以只重新解析和重新切片，不必重新请求远程接口。API token 应保存在数据源配置或密钥管理系统中，不要写入文章 URL、日志、异常堆栈或公开的文档内容。

### 内容去重

建议使用多个层级去重：

1. URL 去重
2. canonical URL 去重
3. 标题 + 发布时间去重
4. 正文内容 hash 去重
5. SimHash 或 MinHash 判断近似重复

## 九、文档切片策略

RAG 效果很大程度取决于切片质量。

### 不建议

直接每 500 个字符粗暴切割：

```text
文章前 500 字
文章中间 500 字
文章后 500 字
```

这样容易破坏：

- 标题层级
- 段落语义
- 列表结构
- 表格结构
- 问答结构

### 推荐切片方式

优先按照解析后的文章结构切分，而不是直接对 API 原始 JSON 或纯文本做固定长度切割：

```text
文章（由 ProseMirror/Tiptap 节点树转换）
├── 标题
├── 导语
├── 一级标题
│   ├── 段落
│   ├── 列表
│   └── 二级标题
└── 结尾
```

建议参数：

- Chunk 大小：400～800 tokens
- Overlap：50～120 tokens
- 中文文章可以从每个 chunk 800～1500 个中文字符、重叠 100～200 个中文字符开始

但最终应使用 Token 计算，而不是简单按字符计算。

### 为每个 chunk 保存上下文

建议在向量化前给 chunk 加上文章上下文：

```text
文章标题：xxx
章节标题：xxx
正文内容：xxx
```

每个 chunk 建议同时保存以下定位信息：

- `document_id`
- `document_version_id`
- `chunk_index`
- `section_path`，例如 `['导语', '02｜选型核心']`
- `source_node_start` 和 `source_node_end`，用于回溯原始节点范围
- `content_type`，例如 `paragraph`、`list`、`quote`、`code`
- `image_refs` 和 `attachment_refs`

这样即使单独召回一个片段，模型也能知道它属于哪篇文章、哪个章节；前端还可以根据节点范围展示精确引用。

## 十、检索策略

不要只做向量检索，建议使用“混合检索”。

### 推荐检索流程

```text
用户问题
  ↓
问题改写
  ↓
关键词检索
  ↓
向量检索
  ↓
合并结果
  ↓
去重
  ↓
Rerank
  ↓
截取上下文
  ↓
调用 LLM
```

### 初始参数

- 向量召回 Top K：20
- 关键词召回 Top K：20
- 合并后：20～30
- Rerank 后：5～8
- 最终传给模型：3～6 个 chunk

### 检索方式

#### 1. 向量检索

适合：

- 语义相似问题
- 用户表达不准确
- 同义词问题
- 间接描述问题

#### 2. PostgreSQL 全文检索

适合：

- 专有名词
- 人名
- 地名
- 精确关键词
- 数字、年份
- 文章标题

可以使用：

- PostgreSQL tsvector
- pg_trgm
- 中文分词插件，或独立搜索引擎

#### 3. Rerank

如果对答案质量要求较高，建议增加 Rerank。流程如下：

```text
向量检索 20 条
      ↓
Rerank 模型重新排序
      ↓
保留前 5 条
```

Rerank 对中文文章问答通常很有帮助。

## 十一、模型选型建议

不要把模型直接绑定在业务代码中，应该抽象统一接口。

### 统一接口

```ts
interface ChatModel {
  streamChat(input: ChatInput): AsyncIterable<ChatChunk>
}

interface EmbeddingModel {
  embedDocuments(texts: string[]): Promise<number[][]>
  embedQuery(text: string): Promise<number[]>
}

interface RerankModel {
  rerank(query: string, documents: string[]): Promise<RerankResult[]>
}
```

### 模型组合建议

#### 方案一：云服务优先

- Embedding：阿里百炼 / 智谱 / OpenAI
- Chat：Qwen / DeepSeek / GLM
- Rerank：云端 Rerank API

优点：

- 上手快
- 运维简单
- 不需要 GPU

缺点：

- 有调用费用
- 数据需要发送到第三方
- 受网络和供应商限制

#### 方案二：本地部署

- Embedding：BGE-M3
- Rerank：bge-reranker-v2-m3
- Chat：Qwen / DeepSeek 开源模型
- 推理框架：Ollama / vLLM

优点：

- 数据控制能力强
- 长期成本可控
- 可以离线运行

缺点：

- 需要 GPU
- 模型运维复杂
- 初期成本更高

### 实际建议

开发阶段：

- Embedding 使用云服务
- Chat 使用云服务
- Rerank 先关闭或使用云服务

上线后根据数据安全和成本决定是否本地化。

## 十二、建议的数据表

核心表可以设计为：

```text
users
roles
permissions
user_roles

knowledge_bases
data_sources
crawl_tasks

documents
document_versions
document_chunks
document_tags
tags
document_assets

chat_sessions
chat_messages
message_sources
message_feedback

model_providers
model_configs
system_configs
audit_logs
```

### documents

```text
id
knowledge_base_id
source_id
source_article_key
url
canonical_url
title
author
category
published_at
content
raw_html
raw_json
content_json
markdown
plain_text
source_format
parser_version
parse_status
parse_error
content_hash
status
version
created_at
updated_at
last_synced_at
```

### document_chunks

```text
id
document_id
knowledge_base_id
content
context_content
chunk_index
token_count
embedding
metadata
section_path
content_type
source_node_start
source_node_end
image_refs
attachment_refs
created_at
```

### document_assets

用于保存正文中的图片、附件和其他可选资源：

```text
id
document_id
document_version_id
asset_type
source_url
storage_key
original_name
mime_type
file_size
asset_index
download_status
metadata
created_at
updated_at
```

### chat_messages

```text
id
session_id
role
content
model_name
prompt_tokens
completion_tokens
latency_ms
first_token_latency_ms
created_at
```

### message_sources

```text
id
message_id
document_id
chunk_id
score
rerank_score
citation_order
```

这样可以分析每次回答到底引用了哪些内容。

## 十三、推荐项目目录

可以使用 pnpm workspace：

```text
rag-project/
├── apps/
│   ├── web/
│   ├── admin/
│   ├── api/
│   └── worker/
├── packages/
│   ├── types/
│   ├── api-client/
│   ├── config/
│   ├── ui/
│   ├── eslint-config/
│   └── tsconfig/
├── infra/
│   ├── docker/
│   ├── nginx/
│   └── migrations/
├── docker-compose.yml
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

### 应用职责

#### apps/web

用户端：

- 问答
- 搜索
- 文章浏览
- 用户中心

#### apps/admin

管理后台：

- 文档管理
- 抓取任务
- 知识库配置
- 模型配置
- 运营数据

#### apps/api

HTTP API：

- 用户认证
- 业务接口
- 问答接口
- 管理接口

#### apps/worker

异步任务：

- 爬虫
- 文档解析
- 文档切片
- 向量化
- 重新索引

## 十四、部署建议

### 第一阶段：单机 Docker Compose

```text
Nginx
PostgreSQL + pgvector
Redis
API
Worker
Web
Admin
```

可以先部署在一台云服务器上。

### Docker Compose 服务

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16

  redis:
    image: redis:7

  api:
    build: ./apps/api

  worker:
    build: ./apps/worker

  web:
    build: ./apps/web

  admin:
    build: ./apps/admin

  nginx:
    image: nginx:alpine
```

### 第二阶段再考虑

- PostgreSQL 主从
- Redis Sentinel
- 独立 Worker 扩容
- 对象存储
- Qdrant
- Kubernetes
- CI/CD
- 监控告警

## 十五、建议的 MVP 开发顺序

不要一开始就开发完整的后台和复杂 RAG，建议分阶段。

### 第一阶段：跑通最小闭环

目标：

```text
抓取几篇文章
    ↓
正文清洗
    ↓
切片
    ↓
生成向量
    ↓
向量检索
    ↓
LLM 回答
    ↓
展示引用来源
```

只需要：

- 一个简单 Vue 页面
- 一个 NestJS API
- 一个 PostgreSQL
- 一个 Redis
- 一个 Worker
- 一个模型供应商

### 第二阶段：补齐管理能力

增加：

- 用户登录
- 管理后台
- 文档管理
- 抓取任务
- 任务状态
- 知识库配置
- 模型配置
- 问答日志

### 第三阶段：提升回答质量

增加：

- 混合检索
- Rerank
- 查询改写
- 多轮对话
- 引用准确性检查
- 召回评估
- 答案质量评估
- Prompt 版本管理

### 第四阶段：生产化

增加：

- 限流
- 审计日志
- 敏感词过滤
- 成本统计
- 监控告警
- 数据备份
- 多租户
- 权限体系
- 模型故障降级

## 十六、最推荐的最终组合

如果现在开始做，建议采用下面这套：

### 前端

Vue 3 + Vite + TypeScript + Pinia + Element Plus/Tailwind

### 服务端

NestJS + Fastify + TypeScript

### 数据库

PostgreSQL 16 + pgvector

### 缓存与队列

Redis + BullMQ

### ORM

Prisma 或 Drizzle

### 爬虫

Crawlee + Playwright + Cheerio + Readability

### AI

Embedding + Chat + Rerank 通过统一 Provider 接口封装

### 工程化

pnpm workspace + Turborepo

### 部署

Docker Compose + Nginx

### 监控

Sentry + Prometheus + Grafana

### 对象存储

MinIO 或云 OSS

## 结论

先采用“模块化单体 + 独立 Worker”，不要一开始做微服务。业务 API 和异步处理逻辑分开即可，未来再根据负载拆分。

其中最关键的并不是前端或 NestJS，而是：

1. 网页正文清洗质量
2. 文档切片策略
3. 混合检索
4. Rerank
5. 引用来源展示
6. 问答评估体系
7. 对抓取内容的授权和合规处理

对于这个项目，第一版完全可以基于现有技术栈完成，不需要引入 Python。只有在后续需要本地模型推理、复杂 NLP 处理或大规模数据处理时，再增加 Python AI 服务。
