# 架构调整 TODO

依据 [技术方案](rag-system-architecture.md) 对照现有代码整理，并结合 [nyzdata 文章样本评估](nyz-article-evaluation.md) 补充；进度记录见 [模块清单](module-status.md)。原则：保留 Fastify + BullMQ 的模块化单体 + 独立 Worker，逐步演进，不整体重写为 NestJS。

建议顺序：一 → 四 → 三，二和五（认证）可以穿插进行（第二阶段已完成）。样本评估表明，现有采集和清洗还无法接入 nyzdata 数据源，检索与问答依赖第四阶段产出的结构化数据，所以第四阶段提前到第三阶段之前。标注「依赖」的条目需先确认后再安装。

## 范围调整（2026-10-23）

- **只通过文章接口获取数据**：移除网页站点采集，数据源只保留 nyzdata 文章 API。
- **只对正文做 RAG**：暂不处理图片与 PDF 附件，相关条目移到「暂不实施」；解析器已存入 `metadata` 的附件、图片信息保留，不参与检索。
- **当前优先级**：
  1. ~~移除网页站点来源（第四阶段）~~，已完成；
  2. ~~文章派生合成评估集与基线，方案见 [evaluation-plan.md](evaluation-plan.md)（第三阶段）~~，已完成（2026-10-24）；
  3. ~~章节父块 + 语义子块切片，方案见 [chunking-design.md](chunking-design.md)，以评估基线验收（第四阶段）~~，已实现并完成实验，没有正收益，暂不上线（2026-10-24）。

## 当前待办（2026-10-24）

按优先级排列；各阶段中其他未完成的条目（问题改写、近似去重、授权确认、角色权限、审计日志、成本统计等）见下文。

### 优先

- [x] **回答层评估（I）**：对评估集运行完整问答（不保存问答记录），统计来源文章被引用的比例，由 LLM 评审回答是否忠实于上下文、是否完整。
  - [x] 工具 `evaluate:answer`（2026-10-24），方案见 [evaluation-plan.md](evaluation-plan.md) 第 8.7 节；
  - [x] 换用不同的审核模型：Chat 为 gemini-3.8-flash-high（CLIProxy），审核为 gpt-6.1-sol；
  - [x] dev 集基线 `answer-topk`、`answer-budget`（2026-10-24）：faithful / complete / citation 通过率 100.0 / 97.5 / 99.6，见 evaluation-plan.md 第 8.8 节。
- [x] **上下文字数预算**：已用回答层评估比较（2026-10-24），结论为暂不调整。线上 topK=5 平均只送入约 3000 字，是 `maxContextLength`（6144）的一半。填满预算后，fused 证据命中由 76.8 升到 94.0，rerank 由 96.8 升到 97.3（evaluation-plan.md 第 8.6 节）。
  - 按字数预算组装与 topK=5 相比，回答质量的差别在 1～2 道题以内，输入 Token 翻倍，首 Token 耗时基本不变（evaluation-plan.md 第 8.8 节）；
  - 线上开启了 Rerank，证据命中已有 96.8，填满预算的收益很小；只有关闭 Rerank 时，才值得按预算组装。
- [x] **业务库有 1 篇主文档未向量化**（覆盖率 99.91%）：已重试，覆盖率 100%（1126 篇，2026-10-24）。
  - 原因：文章 `10383539889` 在 2026-10-23 同步后自动向量化时，Embedding 服务返回 HTTP 503；`embedChunks` 不重试瞬时错误，自动向量化失败后也不重新入队，只能在管理端手动重试；
- [x] **摘要召回走 HNSW 时漏召回**：`summarySearchChunks` 取 10 篇时，业务库的规划器选用 HNSW 近似索引（默认 `ef_search=40`），会漏掉最相近的文章，线上问答同样受影响。已在连接池中把 `hnsw.ef_search` 设为 100（2026-10-24），summary Hit@10 由 79.8 升到 81.5，基线改为 `baseline-ef100`（evaluation-plan.md 第 8.4、8.6 节）。
- [x] **Embedding 瞬时错误不重试**：`embedChunks` 对 429/5xx 与连接失败按批次重试 2 次（1 秒、3 秒，`Retry-After` 超过 10 秒不重试），超时与 4xx 不重试（2026-10-24）。问答的查询向量同样受益，最坏多等约 4 秒；持续数分钟的故障仍需在管理端手动重试。

### 其次

- [ ] **切片规则 1 丢字**：`chunking.ts` 的 `SENTENCE` 拆超长段落时，会丢掉没有句末标点、以换行结尾的行（如长列表的条目）。规则 2 的 `splitSentences` 没有这个问题。
  - 修复会改变现有切片，需要提升 `CHUNKER_VERSION`；
  - 修复后全量「重新处理」，并重新运行基线。
- [ ] **失败题复判（H）**：AI 判断排在来源文章之前的文章能否回答该问题，报告宽松 Hit（evaluation-plan.md 第 7.3 节）。各变体都未召回来源文章的 s0152、s0163 优先复判。
- [ ] **test 集阶段验收**：按 evaluation-plan.md 第十一节，在 test 集（112 道题）上运行一次当前配置，记录到 module-status.md，注明「合成基线，单来源标注」。

### 继续父子块时才做

- [ ] 上下文依赖专项题：结论与条件分处相邻段落、表格数值需要结合正文解释等（[父子块建议](parent-child-chunking-recommendations.md)第五节），单独报告。
- [ ] 子块下向量召回集中在少数文章（排名深度不足的题由 67 道增至 131 道）：加大向量召回的候选数，或按文章去重后再评估。
- [ ] 上线：问答改用 `buildSectionContext`，`message_chunks` 记录父块；`CHUNKER_VERSION` 改为 2，业务库全量「重新处理」。

### 清理

- [ ] 删除实验 schema `eval_legacy`、`eval_sections`（`DROP SCHEMA … CASCADE`），或在下次切片实验前用 `evaluate:index --reset` 重建。
- [ ] 确认业务库已执行迁移 `0017_document_sections`：API/Worker 启动时会自动执行；在业务库上直接运行 `evaluate:retrieval` 前，需要先完成迁移。

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
- PDF 附件（21 篇），已调整为暂不实施；
- 图片信息（996 张中只有 21% 有图注），已调整为暂不实施；
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
- [x] 一次性导入脚本 `pnpm db:import-snapshot`：`.nyz-data/knowledge.json` + `document_vectors` → 新表，可重复执行（旧快照只含网页数据，已随网页来源移除）
- [x] `readSnapshot` / `updateSnapshot` 替换为按实体的 repository（`packages/processing/src/repository.ts`），API 与 Worker 改用数据库事务
- [x] 切片替换与向量清除在同一事务；向量回写用 `processing_version` + 行锁校验切片未变化
- [x] 问答记录与文档列表改为数据库分页与筛选；`/api/knowledge` 不再返回全部文档
- [x] 移除 `proper-lockfile`、`NYZ_STORE_PATH` 与 `.nyz-data` 挂载；同步更新 `docker-compose.yml`、`.env.example`、README、`AGENTS.md`、`CLAUDE.md`
- [x] 集成测试改用临时 schema（`search_path`），结束后删除
- [x] 本地旧 `document_vectors` 表（0 行）已删除，`.env` 已移除 `NYZ_STORE_PATH`；其他环境的旧 `document_vectors` 表只含网页数据，可由管理员直接删除

## 二、API 结构整理

- [x] 将 `apps/api/src/index.ts` 按领域拆分为 Fastify plugin：`chat`、`search`、`documents`、`data-sources`、`crawl-tasks`、`knowledge-bases`、`model-providers`、`common`；`app.ts` 的 `buildApp` 负责组装（可注入队列，便于无基础设施测试），`index.ts` 只负责迁移与监听
- [x] 队列访问封装为 `apps/api/src/queue.ts`（`DocumentQueue`）：文档级 jobId `document-<id>`，同步任务 jobId `sync-<taskId>`；同一来源已有等待/运行中的同步任务时返回 409；入队失败时回写任务/文档失败状态
- [x] 请求/响应校验：选用 Fastify JSON Schema（不新增依赖），集中在 `apps/api/src/schemas.ts`，按 `METHOD /path` 由 `onRoute` 钩子挂载；关闭类型强制转换，参数 ID 校验 UUID（公开文章详情接口除外，未知 ID 返回 404），请求体拒绝未知字段，响应 schema 只输出已声明字段；问答记录 `rating` 筛选取值为 `rated` / `unrated`。测试保证每个路由都有 schema 且 schema 不指向不存在的路由
- [x] 统一错误响应格式与错误处理钩子：所有错误响应均为 `{ error: string }`；4xx 返回原因（含校验失败与非法 JSON），其余错误记日志并返回 `Internal server error`，不泄露内部信息；未知路由返回 404
- [x] 前端 API 调用抽取为共享客户端 `packages/api-client`（`ApiClient.request` / `ApiClient.stream`，解析 SSE 并跳过心跳，`{ error }` 转为 `ApiError`），web 与 admin 均已接入。接口返回类型仍由调用方标注，尚未按路由生成类型化方法

## 三、检索与 RAG 问答

- [x] 在 `packages/processing` 定义统一 Provider 接口（`models.ts`）：`EmbeddingModel`（`embedDocuments` / `embedQuery`）、`ChatModel`（`streamChat`，解析 SSE 与 usage）、`RerankModel`（`rerank`，兼容 `results` / `output.results`）
- [x] 模型配置补充温度、最大 Token；Chat / Rerank 模型接入运行时（均使用默认供应商）
- [x] 向量检索：`vectorSearchChunks` 按模型与维度过滤、余弦相似度与知识库阈值过滤；迁移 `0005` 为 384/512/768/1024/1536/2000 维建立 HNSW 部分表达式索引，查询使用匹配的定维转换。其他维度保留精确扫描；ANN 经模型/元数据过滤后不足候选数时回退到过滤后的精确检索。已用临时 schema 的 `EXPLAIN ANALYZE` 验证索引可用，尚未做全量性能基准
- [x] 关键词检索：应用层生成重叠二元组，经 `array_to_tsvector` 写入 `document_chunks.search_vector`（GIN），不经过数据库分词器；按最少见的 8 个词项筛选候选、BM25 重排。实测 `text[]` + GIN 慢约 40 倍，未采用。`pg_trgm`、中文分词插件后续按评估集再评估
- [x] 索引与查询统一做 NFKC 规范化（化学式上下标 `Na₀.₉` → `na0.9`），词项规则变化后运行 `pnpm db:reindex-search`
- [x] 摘要级向量：「标题 + 摘要」单独向量化存于 `documents.summary_embedding`（与切片同一次调用、同一事务写入，HNSW 部分索引）；检索新增摘要召回，先召回文章（前 10 篇）、再用同一查询向量定位文章内最相关的切片，作为第三路参与 RRF，得分记为 `summaryScore`；Worker 启动时为升级前的文章补齐。尚未用真实模型评估效果
- [x] 元数据过滤：`/api/search`、`/api/chat` 与会话 SSE 接收 `filters`，支持发布时间（`publishedFrom` / `publishedTo`，UTC 日期，含首尾整日）、分类、标签、场景及数据源；同字段多值 OR、跨字段 AND，关键词和向量召回在候选截断前统一过滤，关键词词频统计同样限定检索范围
- [x] 元数据加权：关键词、项目名称、负责人、承担单位的词项写入 `documents.metadata_search_vector`（GIN）。只命中元数据的文档另行召回（最多 20 篇，每篇取一个切片），不占用正文候选；按 IDF × 字段权重（名称/负责人 1.0、单位 0.8、关键词 0.5）加分，同一词项只取最高权重；每篇文档只给最佳切片加一次，常见词项不加分。标题中提取的机构与期刊（全称 + 缩写）以 0.5 权重加入（标题已在切片上下文中计过一次）
- [x] 回答引用同时标注 nyzdata 文章与原始转载源（`sources[].repostSource`，来自 `metadata.sourceMeta`）
- [x] 文章衍生的合成检索评估集：`packages/processing/test/evaluation/retrieval-dataset.json` 含 50 条问题、稳定文章 ID、相关性等级与证据摘录；`pnpm evaluate:retrieval` 提供离线及数据库关键词基线，输出 Recall@K、MRR、nDCG@K 和语料缺失统计。不代表真实用户或人工复核标注，不用于宣称混合检索质量
- [ ] 文章派生合成评估集与基线（方案见 [evaluation-plan.md](evaluation-plan.md)）：AI 按文章生成带原文证据的问题，经程序校验与 AI 审核，单来源标注（来源文章 + 证据），标记 `source=synthetic`、单独报告，作为切片与检索调整的回归基线；目前没有人工标注资源
  - [x] 前置：语料入库并完成向量化（2026-10-23：主文档 1126 篇，同步暂停，未全量），评估用知识库参数随运行记录保存
  - [x] 数据集 schemaVersion 2（题型、具体度、来源、参考答案、多段证据、dev/test 按文章划分），兼容 v1
  - [x] `evaluate:generate`：语料快照、分层抽样（首版 400 篇）、生成、程序校验（证据存在、指代、词面重叠、重复）、AI 审核、重试与断点续跑、冻结导出
  - [x] 评估命令 `--mode=hybrid`：调用真实 `retrieve()`，`--variant` 逐路消融；排名列表（30 个候选）与回答上下文分离；输出来源文章 Hit@K、MRR、Evidence Hit、上下文命中、耗时与降级，按题型/具体度/词面重叠分组
  - [x] 运行结果保存（语料指纹、参数、逐题排名）与 `evaluate:compare` 对比
  - [x] 产出 `synthetic-v1`（350 题，dev 238 / test 112）与 dev 基线运行记录（2026-10-24）
  - [x] 实验索引 `evaluate:index`（`eval_*` schema）、`--schema` 与 `--context=topk|budget|section`、全部证据覆盖率与上下文字数（2026-10-24）
  - [ ] 失败题复判：AI 判断排在来源文章之前的文章能否回答，报告宽松 Hit
  - [x] 回答层评估工具 `evaluate:answer`：来源文章引用比例、LLM 评审忠实度与完整度（2026-10-24），dev 基线 `answer-topk` 已运行
  - [ ] 后续（有真实提问积累后）：真实问题 AI 银标集（候选池 + AI 分级判定 + 抽查）；人力到位后再做人工标注集与管理端标注模块
- [ ] 问题改写：追问时结合历史把问题改写为独立问题后再检索，失败时用原问题；以评估集中的多轮追问题验收
- [x] 混合召回（向量/关键词各 20 条）、RRF 合并去重（前 30 条）、可选 Rerank，取知识库 `topK` 条送入模型；向量检索或 Rerank 失败时降级。问题改写未做
- [x] Prompt 组装：知识库回答提示词 + 引用规则，参考资料按文章编号分组，按上下文最大长度截取
- [x] 会话接口：`POST /api/chat/sessions`、`GET /api/chat/sessions`、`GET /api/chat/sessions/:id/messages`，另有 `DELETE /api/chat/sessions/:id`。会话尚无用户归属（随第五阶段用户登录处理）
- [x] SSE 流式问答，事件 `source` / `token` / `done` / `error`。改为 `POST /api/chat/sessions/:id/stream`（问题最长 2000 字，放在 URL 中会超出 Nginx 默认请求头长度），支持 `regenerate` 重新生成最后一轮；追问带最近 3 轮历史，问题改写未做
- [x] 记录引用来源（`message_sources`，含转载源）与召回片段（`message_chunks`：chunk、引用编号、RRF/向量/关键词/Rerank 得分、摘录），以及检索耗时、首 Token 耗时、总耗时与 Token 用量
- [x] 用户端：流式输出、引用展示、重新生成、复制回答、停止生成、历史会话；管理端问答详情展示召回片段、耗时、所属会话与替换状态
- [x] `GET /api/documents/:id` 文章详情接口与用户端 `/#/documents/:id` 文章页：仅公开已就绪文档的正文和元数据，不返回原始输入、切片或内部错误；问答引用跳转、基础 Markdown 展示、转载来源、返回问答、加载/错误/重试状态及移动端布局。HTML 作为文本展示，链接限制安全协议

## 四、采集、清洗与切片

- [x] 文章 API 数据源：来源地址为文章列表接口（如 `…/nyzfoxx/article?tagKey=…`），详情接口为同路径 `/articleDetail`；token 只从 Worker 环境变量 `NYZ_ARTICLE_TOKEN` 读取，API 拒绝带 token 的地址，错误信息不含 URL
- [x] ProseMirror/Tiptap 解析器（纯函数，`packages/processing/src/article/parse.ts`）：由 `parse.mjs`（v3）移植，初始版本在 200 篇样本上输出一致；当前 v4 增加项目导读元信息提取。生成 Markdown 与纯文本，未知节点记录到 `metadata.unknownNodeTypes` 并继续
- [x] 章节角色：相关阅读、本文链接不进入正文与切片，提取为 `relatedArticleKeys` 与 DOI；延伸思考不做向量化，提取为 `metadata.followUpQuestions`
- [x] 文首元信息（作者/转载源/关键词/场景，`[[双链]]`）与项目导读信息（项目名称/负责人/承担单位/关键词）提取为结构化字段，不进入检索正文与切片正文。分别存于 `metadata.sourceMeta` / `metadata.projectMeta`，完整 Markdown 保留原始字段；项目关键词加入切片上下文，管理端详情 API 保留项目字段。引用已标注原始转载源（见第三阶段）。解析器 v4 对文首连续字段块保守识别，不推断机构或负责人，不单独拆解嵌在名称中的项目编号；历史文档需执行「重新处理」后生效
- [x] 误用标题（超长、以句末或冒号结尾）降级为段落，标题文字计入切片；从标题解析机构与期刊（解析器 v5，`article/title.ts`，存于 `metadata.titleMeta`）。期刊只认词典并须紧挨标题头部末尾，识别出期刊才提取机构，机构须为「纯汉字机构名 + 人名」的完整项，其余忽略；历史文档需「重新处理」后生效
- [x] 列表接口增量同步：按 `updateTime` 判断变化，置顶文章不参与停止判断，连续 `NYZ_ARTICLE_OVERLAP_PAGES` 页无变化才停止；单次上限 `NYZ_ARTICLE_SYNC_LIMIT`，回填进度与失败文章记录在 `data_sources.sync_state`，下次继续；`invalidToken`、401/403 中止同步，无正文（VIP/无权限）的文章记为失败
- [x] 移除网页站点来源（2026-10-23）：删除 Worker 网页抓取、`chunkText`、`canonicalUrlFromHtml`、`CRAWL_MAX_PAGES` 与旧快照导入命令，请求间隔/超时改名为 `NYZ_ARTICLE_REQUEST_*`；迁移 `0011` 删除网页来源及其文档、删除 `raw_html` 列，`raw_json`/`external_id` 必填，来源类型只允许 `文章 API`（原为网页文档重复项的文章置为处理失败，需重新处理）；API、管理端与测试同步。`normalizeUrl` 与正文指纹去重保留
- [ ] 近似去重（MinHash 等）：同一论文的多版改写只保留一篇或合并。样本中只有 1 对，优先级低
- [ ] 与数据提供方确认转载内容的使用授权（样本中 85.5% 转载自微信公众号并经 AI 改写）
- [x] 保存原始 JSON（`documents.raw_json`）与 `parser_version`；「重新处理」用当前解析器重新解析和切片，无需再次请求接口
- [x] 文档补充字段：`canonical_url`、`author`、`category`、`published_at`、`content_hash`、`parse_status`、`parse_error` 等。（已加 `external_id`、`canonical_url`、`author`、`category`、`tags`、`published_at`、`source_updated_at`、`content_hash`、`duplicate_of`、`markdown`、`metadata`；解析状态复用 `processing_status`/`processing_error`）
- [x] 去重：URL 规范化、canonical URL、正文指纹（`content_hash`）。跨来源重复保留为重复文档（`duplicate_of` 指向最早入库的主文档，不切片、不向量化、不参与检索），管理端展示其他来源；主文档变化或删除时由重复文档接替；按指纹咨询锁处理并发。标题 + 发布时间去重未做
- [x] 结构化切片（`packages/processing/src/chunking.ts`）：同章节累积约 800 字，过短章节并入下一节，表格不超过两倍目标长度时整块保留（更长按行切分并重复表头），超长段落按句切分；网页按行切分，不再折叠空白
- [x] 章节父块 + 段落子块切片（切片规则 2，方案与实际实现见 [chunking-design.md](chunking-design.md) 第六节）：`chunkSections`、`document_sections`、`chunker_version`、`buildSectionContext` 已实现。在实验索引上与基线对比后，没有正收益，暂不启用（`CHUNKER_VERSION` 仍为 1，[evaluation-plan.md](evaluation-plan.md) 第 8.6 节）。继续推进的条目见「当前待办」
- [x] 向量化前为 chunk 添加上下文前缀（文章标题、章节、前 8 个关键词），存于 `document_chunks.context`；保存 `section_path`、`content_type`。节点范围未保存
- [ ] Worker 拆分为独立阶段任务（采集 → 解析 → 切片 → 向量化），各阶段可单独重试。Worker 并发为 1 且「重新处理」可从 `raw_json` 重跑，优先级低

## 五、认证与生产化

- [x] `/api/admin/*` 增加管理员认证（单管理员账号登录，Redis 会话 Cookie）
- [x] 用户登录、历史会话、反馈记录：邮箱验证码注册/登录/找回密码，会话、问答与反馈按账号或匿名访客归属（`apps/api/src/user-auth.ts`、`users.ts`）
- [x] Redis 限流：IP、用户、问答频率与并发，以及模型调用准入（`apps/api/src/rate-limit.ts`、`packages/processing/src/admission.ts`）
- [ ] 角色权限（进行中：超级管理员与普通管理员账号，超级管理员管理其他管理员）
- [x] 后台配置密钥（2026-10-23）：nyzdata token 与模型 API Key 在管理端填写，以 `NYZ_SECRET_KEY` 加密入库、只写不读；移除 `NYZ_ARTICLE_TOKEN` 环境变量；模型密钥可选（本地模型）
- [x] 供应商与模型解耦：供应商只管连接，业务模型为 Chat / Embedding / Rerank 分别选择供应商与模型；模型配置页支持服务类型预设、测试连接与从模型列表选择模型
- [ ] 审计日志
- [x] 文档处理互斥：改用 PostgreSQL 会话级咨询锁（`withDocumentWork` / `lockDocument`，键 `nyz-rag:document:<id>`），未采用 Redis 锁。锁随数据库连接释放，Worker 崩溃不残留，无需 TTL 与续期，并与行锁、`processing_version` 校验在同一系统内；持锁期间占用一个连接，提高 Worker 并发时需相应调大连接池
- [ ] 成本统计（问答记录已有 Token 用量，可按天/模型汇总）、监控告警、数据备份

## 暂不实施

NestJS 整体重写、Qdrant/Milvus、MinIO/对象存储、Kubernetes、Prometheus/Grafana。待数据量或运维需求出现后再评估。

按 2026-10-23 范围调整，以下条目暂不实施：

- PDF 附件解析（样本中 21 篇报告导读、项目导读的完整内容在附件中）
- 图片与附件元数据单独保存（`document_assets`）及图片信息检索
- 网页采集相关：Cheerio + Readability 正文提取、robots.txt 按 User-agent 完整解析（随网页来源一并移除）
- 精确 Token 计数（需引入分词器依赖；切片按字数控制，估算值够用）
- 基于 Embedding 的语义切分、LLM 生成切片上下文（Contextual Retrieval），待评估集证明收益后再评估
