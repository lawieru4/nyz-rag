# 架构调整 TODO

依据 [技术方案](rag-system-architecture.md) 对照现有代码整理，并结合 [nyzdata 文章样本评估](nyz-article-evaluation.md) 补充；进度记录见 [模块清单](module-status.md)。原则：保留 Fastify + BullMQ 的模块化单体 + 独立 Worker，逐步演进，不整体重写为 NestJS。

建议顺序：一 → 四 → 三，二和五（认证）可以穿插进行。样本评估表明，现有采集和清洗还无法接入 nyzdata 数据源，检索与问答依赖第四阶段产出的结构化数据，所以第四阶段提前到第三阶段之前。标注「依赖」的条目需先确认后再安装。

## 样本评估结论（200 篇，2026-10-21）

详见 [nyzdata 文章样本评估](nyz-article-evaluation.md)。两批各 100 篇的指标基本一致，结论稳定。

**保留**：模块化单体 + 独立 Worker、PostgreSQL + pgvector、Redis + BullMQ。全量 7068 篇约 4.9 万个切片、2700 万字，在 pgvector 适用范围内，不需要独立向量库。

**必须调整**：

| 问题 | 样本数据 | 对应阶段 |
| --- | --- | --- |
| JSON 快照无法支撑全量 | 全量估算约 580 MB，每次写入整体重写 | 一 |
| 无法接入文章 API | 现有 Worker 只支持 HTML 采集，文章 API 来源直接报错 | 四 |
| 清洗抹掉结构 | 现有切片 57.1% 跨章节、81.3% 从句子中间开始、仅 5.3% 含文章标题、切断表格 48 处 | 四 |
| 非答案内容混入检索 | 23.3% 的切片混入相关阅读/本文链接，22.6% 混入延伸思考提问；这类内容约占全文 11% | 四 |
| 文首元信息被当作正文 | 85.5% 的文章以「作者：qwen3.6-plus / 转载源 / 关键词 / 场景」开头，另有 19 篇以项目信息开头 | 四 |
| 回答取正文前 180 字 | 因上一条，95% 的回答只是元信息 | 三 |
| 分词拆坏化学式 | 约 80% 的文章含 Unicode 上下标；不重叠二元组丢掉一半组合 | 三 |
| 去重和增量同步 | 有 1 对近似重复（Jaccard 0.86）；列表含 6 条置顶，且有 11 处时间乱序 | 四 |

**新增需求**：
- 混合检索（化学式、期刊、机构、中英人名）；
- 元数据过滤（场景为固定词表，关键词为长尾）；
- 摘要级召回；
- PDF 附件（21 篇）；
- 图片信息（996 张中只有 21% 有图注），优先级低；
- 转载来源标注与使用授权确认。

**评估局限**：代理测试的问题取自原文，现有算法也有 90% 以上的命中率，区分不出方案好坏。需要用带标注的真实问题评估集复测。

## 已完成

- [x] 获取 200 篇样本，逐篇清洗并保存到 `.nyz-data/nyz-articles/`（原始 JSON、清洗结果、Markdown、统计报告）
- [x] ProseMirror 解析器原型 v3（`scripts/nyz-articles/parse.mjs`）：覆盖样本中的全部节点类型，支持章节角色、元信息提取、误用标题降级、DOI 与关联文章提取
- [x] 抓取（支持断点续跑）、重新解析、分析脚本：`fetch.mjs`、`reparse.mjs`、`analyze.mjs`
- [x] 样本评估报告 `docs/nyz-article-evaluation.md`

## 一、元数据迁移到 PostgreSQL

- [x] ORM：Drizzle（`drizzle-orm` 0.45、`drizzle-kit` 0.31），复用现有 `pg`；表结构在 `packages/processing/src/schema.ts`
- [x] 表结构：`data_sources`、`crawl_tasks`、`documents`、`document_chunks`、`knowledge_bases`、`chat_messages`、`message_sources`、`model_providers`（迁移由 `pnpm db:generate` 生成到 `packages/processing/migrations`）
- [x] `document_chunks.embedding` 承载向量，替代独立的 `document_vectors` 表；保留 `provider_id`、`model`、`dimensions`
- [x] 迁移目录（`packages/processing/migrations`，随包发布便于容器内执行）与 `pnpm db:generate` / `pnpm db:migrate`；API/Worker 启动时自动执行，咨询锁防并发
- [x] 一次性导入脚本 `pnpm db:import-snapshot`：`.nyz-data/knowledge.json` + `document_vectors` → 新表，可重复执行
- [x] `readSnapshot` / `updateSnapshot` 替换为按实体的 repository（`packages/processing/src/repository.ts`），API 与 Worker 改用数据库事务
- [x] 切片替换与向量清除在同一事务；向量回写用 `processing_version` + 行锁校验切片未变化
- [x] 问答记录与文档列表改为数据库分页与筛选；`/api/knowledge` 不再返回全部文档
- [x] 移除 `proper-lockfile`、`NYZ_STORE_PATH` 与 `.nyz-data` 挂载；同步更新 `docker-compose.yml`、`.env.example`、README、`AGENTS.md`、`CLAUDE.md`
- [x] 集成测试改用临时 schema（`search_path`），结束后删除
- [x] 本地旧 `document_vectors` 表（0 行）已删除，`.env` 已移除 `NYZ_STORE_PATH`；其他已有数据的环境需先执行 `pnpm db:import-snapshot` 核对后再删除该表

## 二、API 结构整理

- [ ] 将 `apps/api/src/index.ts` 按领域拆分为 Fastify plugin：`chat`、`search`、`documents`、`data-sources`、`crawl-tasks`、`knowledge-bases`、`model-providers`、`common`
- [ ] 队列访问封装为独立模块，统一 jobId 与重复任务检测（当前 `hasDocumentJob`）
- [ ] 请求/响应校验：选用 Fastify JSON Schema 或 Zod。依赖（若选 Zod）：`zod`、`fastify-type-provider-zod`
- [ ] 统一错误响应格式与错误处理钩子
- [ ] 前端 API 调用抽取为共享客户端（文档建议的 `packages/api-client`）

## 三、检索与 RAG 问答

- [ ] 在 `packages/processing` 定义统一 Provider 接口：`EmbeddingModel`（`embedDocuments` / `embedQuery`）、`ChatModel`（`streamChat`）、`RerankModel`（`rerank`）
- [ ] 模型配置补充 Chat / Rerank 模型、温度、最大 Token，并接入运行时
- [ ] 向量检索：按维度建立 HNSW 部分表达式索引（如 `((embedding::vector(1024))) WHERE dimensions = 1024`），或由知识库固定维度
- [ ] 关键词检索：应用层生成重叠二元组写入 `tsvector`（`simple` 配置）替代字符串包含匹配；`pg_trgm` 需先验证当前 locale 下的中文效果，中文分词插件后续评估
- [ ] 索引与查询统一做 NFKC 规范化（化学式上下标 `Na₀.₉` → `Na0.9`）
- [ ] 摘要级向量：对文章摘要单独向量化，支持先召回文章、再召回切片
- [ ] 元数据过滤：发布时间、分类、标签、场景（固定词表）参与过滤；关键词、机构、期刊、项目负责人用于关键词加权
- [ ] 回答引用同时标注 nyzdata 文章与原始转载源
- [ ] 建立 50 条以上带标注的真实问题评估集，作为切片与检索调整的回归基线
- [ ] 混合召回、合并去重、Rerank，参数读取知识库配置（向量/关键词 Top K 20，Rerank 后 5～8，送入模型 3～6）
- [ ] Prompt 组装：使用知识库回答提示词与上下文最大长度
- [ ] 会话接口：`POST /api/chat/sessions`、`GET /api/chat/sessions`、`GET /api/chat/sessions/:id/messages`
- [ ] SSE 流式问答 `GET /api/chat/sessions/:id/stream`，事件 `token` / `source` / `done`
- [ ] 记录 `message_sources`（chunk、score、rerank_score、引用顺序）及检索耗时、首 Token 耗时、总耗时
- [ ] 用户端：流式输出、引用展示、重新生成、复制回答；管理端问答详情展示召回片段与耗时
- [ ] `GET /api/documents/:id` 文章详情接口与用户端文章页

## 四、采集、清洗与切片

- [ ] 文章 API 数据源：配置 token、articleKey，调用文章详情接口；token 不写入 URL、日志与错误信息
- [ ] ProseMirror/Tiptap 解析器（纯函数）：生成 `content_json`、`markdown`、`plain_text`，未知节点记录到 `unknown_node_types` 并继续。以 `scripts/nyz-articles/parse.mjs`（v3）为原型移植到 Worker 并补充单元测试
- [ ] 章节角色：相关阅读、本文链接不进入检索语料，提取为关联文章与 DOI；延伸思考不做向量化，用作推荐追问
- [ ] 文首元信息（作者/转载源/关键词/场景，`[[双链]]`）与项目导读信息（项目名称/负责人/承担单位）提取为结构化字段，不进入正文；引用时标注原始转载源
- [ ] 误用标题（超长、以句末或冒号结尾）降级为段落，标题文字计入切片；从标题解析机构与期刊
- [ ] 列表接口增量同步：列表含置顶文章且非严格按时间排序，按 `updateTime` 判断变化并扫描重叠窗口，不能遇到已知文章即停止；支持断点续传；处理 `invalidToken` 与 VIP 文章
- [ ] 近似去重（MinHash 等）：同一论文的多版改写只保留一篇或合并
- [ ] PDF 附件解析（样本中 21 篇报告导读、项目导读的完整内容在附件中）
- [ ] 与数据提供方确认转载内容的使用授权（样本中 85.5% 转载自微信公众号并经 AI 改写）
- [ ] 保存原始 JSON 与 `parser_version`，解析器升级时只重新解析和切片
- [ ] 文档补充字段：`canonical_url`、`author`、`category`、`published_at`、`content_hash`、`parse_status`、`parse_error` 等
- [ ] 去重：URL、canonical URL、内容 hash
- [ ] 网页正文提取改用 Cheerio + Readability 替代正则。依赖：`cheerio`、`@mozilla/readability`（及 DOM 实现）
- [ ] robots.txt 按 User-agent 分组完整解析 Disallow/Allow 规则
- [ ] 结构化切片：按标题与段落切分，使用 Token 计数替代字符估算；表格整块保留；过短章节并入相邻章节。不再用 `replace(/\s+/g, " ")` 折叠正文
- [ ] 向量化前为 chunk 添加上下文前缀：以文章标题为主（通常含机构与期刊），附章节与关键词；模板章节名单独几乎不提供信息。保存 `section_path`、`content_type`、节点范围
- [ ] Worker 拆分为独立阶段任务（采集 → 解析 → 切片 → 向量化），各阶段可单独重试
- [ ] 图片与附件元数据单独保存（`document_assets`），默认不参与 Embedding

## 五、认证与生产化

- [ ] `/api/admin/*` 增加管理员认证（先用 token 或简单登录）
- [ ] 用户登录、历史会话、反馈记录
- [ ] Redis 限流：IP、用户、模型接口
- [ ] 角色权限、审计日志
- [ ] 文档同步分布式锁（`document-lock:{documentId}`）
- [ ] 成本统计、监控告警、数据备份

## 暂不实施

NestJS 整体重写、Qdrant/Milvus、MinIO/对象存储、Kubernetes、Prometheus/Grafana。待数据量或运维需求出现后再评估。
