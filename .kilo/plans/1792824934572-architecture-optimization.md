# 三端架构评估与分阶段优化计划

## 结论与已确认边界

- 保留 Vue web/admin 双应用、Fastify API、BullMQ Worker、PostgreSQL/pgvector 的模块化单体，不拆微服务、不新增向量数据库。
- 用户已确认：全部访客/用户共用公开文章库；当前知识库是检索参数与提示词配置，不是资料权限空间。多租户、私有文章和知识库资料隔离不在本计划范围。
- 用户已确认：普通管理员负责内容运营；超级管理员管理服务端密钥、模型连接和文章来源地址。服务端必须授权，不能只隐藏按钮。
- 本轮证据来自源码静态检查，未执行测试、浏览器复现、性能压测或线上故障注入；风险场景不等于已发生的线上故障。
- 本计划的直接实施范围仅为第一批。第二、三批是后续架构路线，不随第一批自动实施，尤其不得自动迁移业务数据库、启动业务 Worker 或发起付费模型调用。

## 现状与高价值问题

```text
web / admin -> api-client + types -> Fastify API
                                      | PostgreSQL：业务、会话、文章、向量
                                      | Redis：会话、准入、BullMQ
                                      v
                                   Worker -> 文章 API / 模型服务

API / Worker -> processing：解析、切片、数据库访问、检索、模型调用
```

| 范围 | 已有合理设计 | 主要优化点及证据 |
| --- | --- | --- |
| 客户端 | 会话 composable、展示组件、共享 SSE 客户端，最终 done 作为权威结果 | 历史加载没有请求身份，旧请求可覆盖新会话；仅加载前 30 个会话。`apps/web/src/composables/useChatSession.ts:43-72` |
| 管理端 | Vue Router 业务页面；分页 composable 已有取消和旧响应隔离 | 概览 HTTP 与 SSE 直接写同一状态，退出清空不能阻止旧响应回写。`apps/admin/src/workspace.ts:21-58` |
| 管理写入 | 部分账号页面已有 pending 保护 | 来源、知识库、模型表单未统一提交锁；写入成功但刷新失败可能被误报为写入失败。`apps/admin/src/components/SourceCreateDialog.vue:17-35` |
| API | 按领域注册插件、JSON Schema 响应白名单、Cookie/CSRF/账号权限基础 | 模型测试能把已有密钥或任意指定环境变量发给表单地址；敏感路由缺少超级管理员限制。`apps/api/src/model-providers.ts:68-82`、`packages/processing/src/provider.ts:59-67` |
| 跨域 | Docker 同源代理合理 | 管理端 CORS 缺少 PUT，但业务模型和 token 使用 PUT。`apps/api/src/app.ts:37-43` |
| 异步任务 | 文档工作锁、短事务、版本校验已有较好保护 | DB 创建任务后再入 Redis 存在双写窗口；队列检查不能原子阻止同来源并发。`apps/api/src/crawl-tasks.ts:10-16`、`apps/api/src/queue.ts:24-33` |
| 向量化 | 外部模型调用在事务外，回写检查文档版本 | 自动向量化失败只记录失败，缺少独立持久化重试链路。`apps/worker/src/index.ts:21-54` |
| 检索 | 关键词、切片向量、摘要召回、RRF、可选 rerank | 向量仅按模型名和维度匹配，跨供应商同名模型可能混用空间。`packages/processing/src/repository.ts:584-636` |
| 共享模块 | processing 不反向依赖应用，types 区分公开和管理 DTO | repository 跨多个业务领域，Worker 入口承载全部任务编排；应按用例逐步拆分，不为目录美观重写 |

## 第一批：边界与前端状态修正

目标：不改变文章、队列、索引的数据模型，先建立可信的敏感权限边界和异步 UI 生命周期。按下列顺序实现，每项可独立验证。

### 1. 收紧敏感配置与凭据出口

影响：`apps/api/src/admin-auth.ts`、`admin-accounts.ts`、`model-providers.ts`、`settings.ts`、`data-sources.ts`、`schemas.ts`、`packages/processing/src/provider.ts`，及对应管理端页面。

1. 将现有局部 `assertSuper` 提取为共用授权机制；默认拒绝非超级管理员的敏感操作，返回现有 `{ error: string }` 格式的 403。
2. 权限矩阵：普通管理员可读取不含秘密的配置状态、操作文章/任务、暂停或恢复已有来源、编辑知识库检索参数/提示词；超级管理员专属来源创建及未来 URL 修改、文章 token 写入/删除、供应商增删改、模型连接测试/模型列表外呼、业务模型选择修改。
3. 管理端按相同矩阵提供只读状态或禁用操作；路由权限和按钮限制只做体验保护。直接请求 API 仍必须被拒绝。
4. 引用已保存凭据测试连接时，服务端使用保存的 endpoint；表单改了 endpoint 则要求显式提供新密钥，禁止把保存密钥借给任意地址。供应商修改 endpoint 时也不得静默保留旧凭据，须明确重新提供或清除。
5. 使用部署配置 `NYZ_MODEL_CREDENTIAL_ENVS` 维护允许读取的环境变量名列表，默认空；API 与 Worker 共用解析校验，所有 credentialEnv 读取入口都必须校验。白名单不包含值，禁止把任意 `process.env` 变成密钥来源。
6. 携带凭据的外呼禁止自动重定向；本地模型 HTTP 支持暂时保留，不将“允许本地模型”误判为必须禁用的能力。完整出口 host/IP 策略留待部署信息明确后另行设计。
7. 为敏感配置变更增加最小结构化审计日志：操作者、资源 ID、动作、结果和 requestId；不记录密钥、请求体或上游原始错误正文。
8. 将 PUT 加入管理端 CORS 方法列表，补预检验证。

上线约束：先清点已配置的 credentialEnv 名称和 endpoint，不读取或输出密钥值；由部署方填好白名单后再发布 API/Worker。未获允许的旧配置应明确报不可用，不回退为匿名调用。继续兼容既有加密密文，无需重加密或更换 NYZ_SECRET_KEY。权限收紧先发布服务端，再发布管理端；不把回退到旧的宽松鉴权当作安全回滚。

### 2. 客户端会话生命周期

影响：`apps/web/src/composables/useChatSession.ts`、`App.vue`、`components/SessionSidebar.vue` 及现有测试。

1. 沿用管理端 `usePaginatedList` 的 AbortController + 请求序号模式，不引入 Pinia 或全局请求框架。
2. 会话详情、历史列表分别拥有请求身份；切换会话、新建、开始生成、登录/退出及卸载让旧请求失效。使用身份 generation 防止跨登录状态回写。
3. 区分身份初始化、历史读取和生成中状态；初始化完成前不发起依赖身份的问答操作。生成占用必须在首次 await 前建立，防止连续触发提交。
4. 临时网络/5xx 错误保留当前会话；仅明确的会话失效响应清除本地引用。成功清除过期错误提示。
5. 使用既有 total 和分页参数提供“加载更多”，按 ID 去重；首次仍取 30 条。
6. source 事件保留 excerpts 等完整来源字段，保持 done 的权威覆盖语义，不在本批变更 SSE 协议。

不变量：旧身份、旧会话、旧请求的结果不能改变当前状态；停止/失败不能被伪装成保存成功。

### 3. 管理端读写生命周期

影响：`apps/admin/src/workspace.ts`、`App.vue`、来源/知识库/文档页面、模型配置弹窗。

1. 概览模块增加工作区 generation、读取取消和去重；退出或重置时失效所有旧读取。
2. 每次 SSE 更新递增本地快照序号；HTTP 请求记录启动时序号，只能在其间没有更新快照且仍属当前 generation 时应用结果。统一入口处理 JSON 异常和可恢复连接错误。
3. 模型列表加载使用请求序号和取消，成功、失败、finally 均检查请求身份；覆盖 A→B→A 和关闭后重开，不只比较 providerId。
4. 来源、知识库和模型表单增加 saving 入口保护与禁用状态；行级写操作使用 pending ID。提交期间禁止关闭/重开该表单，避免旧提交关闭新编辑。
5. 分离“写入失败”和“写入成功但刷新失败”；成功后更新局部状态/关闭表单，刷新失败显示真实结果，不鼓励再次提交。

### 4. 契约与验证门禁

1. 敏感路由的 403/错误响应同步更新 `schemas.ts`，保持路由 schema 覆盖和不泄漏秘密的约束。
2. 优先使用现有共享请求 DTO 和 `satisfies`；不全面引入代码生成或重写 api-client。
3. 为两端测试增加独立类型检查入口，修正已有测试 fixture 的契约漂移。
4. 将 api-client 测试中对 AdminApiClient 的测试移到 admin，避免底层包反向依赖应用。
5. 增加根验证入口聚合实际存在的各包测试；不通过新增测试框架解决已有框架能覆盖的问题。

## 第一批验收与证据路径

| 主张 | 验证负责人/范围 | 最小证据 |
| --- | --- | --- |
| 敏感权限不可绕过 | API 实施者 | 真实路由 app.inject，普通管理员逐项 403、超级管理员可用；不能仅测 schema stub |
| 凭据不发送到任意地址 | 模型适配实施者 | fake fetch 捕获目的地址与授权头：保存地址/修改地址/非白名单变量/重定向；断言密钥不出现在响应日志 |
| 旧请求不覆盖当前 UI | 前端实施者 | deferred promises 控制逆序，覆盖 A/B、开始新会话、读取中提问、退出后返回、A→B→A；同时模拟忽略 abort 的传输 |
| 提交结果准确 | 管理端实施者 | 双击仅一次 mutation；mutation 成功刷新失败仍提示成功；表单提交中不能被另一轮编辑替换 |
| HTTP/SSE 更新有序 | 管理端实施者 | 先发 HTTP，后收到 SSE，再返回 HTTP，断言不回退；退出后旧事件/请求均不回写 |
| 浏览器契约可用 | 集成验证负责人 | 本地浏览器检查跨域 PUT、401/403、历史更多、登录切换与 SSE；同源 Nginx 再做一次 smoke test |

必跑：`pnpm typecheck`、`pnpm build`、`pnpm --filter @nyz-rag/processing test`、`pnpm --filter @nyz-rag/api test`、`pnpm --filter @nyz-rag/api-client test`、`pnpm --filter @nyz-rag/web test`、`pnpm --filter @nyz-rag/admin test`。

本批优先使用现有测试能力；若浏览器自动化需要新增依赖，先确认，不直接引入。无法完成的浏览器场景明确记录为未验证，不能用类型检查替代。共享 PostgreSQL/Redis 不做破坏性操作，不启动同业务队列的额外 Worker，不调用真实文章或付费模型验证。

## 第二批：可靠任务与执行上下文，单独设计实施

优先于性能扩容，但不在第一批中实施。

1. 引入 PostgreSQL operation/outbox：业务状态和任务意图同事务提交，dispatcher 按 operationId 重复安全投递 BullMQ；Worker 以目标内容版本和完成状态防重复效果。DB→队列不声称 exactly-once。
2. 内部任务 ID 改为 UUID；来源增加数据库级活动操作约束和 owner/version，保护同步游标。来源级互斥不能由文档锁或单进程 concurrency=1 替代。
3. 自动向量化成为可恢复独立操作；区分临时失败与永久失败，有限退避、保留有界失败历史、对账无有效 owner 的处理中操作。
4. API producer 有界失败，不扫描全队列判断业务状态。普通运营端展示等待/重试/失败等真实状态。
5. 统一 signal、deadline、requestId/operationId；覆盖检索模型调用、重试等待和任务检查点。明确暂停只阻止新任务，取消才终止进行中的任务。
6. 会话提交增加 revision 或单会话活跃生成约束；首 token 后失败/替换、上游 EOF 和持久化边界另行明确，不能随意修改 done 协议。

设计门槛：先确定 operation 状态机、租约/对账参数、来源暂停/取消 API 和旧任务兼容窗口。采用增量迁移、停接新任务并排空旧任务后切换生产者；保留旧字段直到验证完成。隔离 schema 和唯一队列注入 DB 提交后退出、Redis 确认丢失、双 Worker、重复投递、向量化失败等场景。不得直接在业务库演练。

## 第三批：索引版本、性能与模块演进，单独设计实施

1. 引入不可变 embeddingSpaceId，绑定供应商/部署、模型版本、维度与输入规则版本；查询、切片、摘要、回填和覆盖率使用同一标识。仅 providerId 不足以识别原址同名模型升级。
2. 分离最后成功索引和构建中的操作，按新空间构建、校验后切换；旧向量身份不明时不得强行标记为新空间。存储方案、重建费用与维护窗口需单独确认。
3. 修正跨来源去重与 sourceId 筛选的语义冲突，保留来源归属与正确引用，不引入私有知识库权限模型。
4. 按业务用例逐步拆分 repository、Chat orchestration 和 Worker handlers；保留单包/单部署边界，避免机械创建大量接口和目录。
5. 先测真实 SQL 的 EXPLAIN、端到端 p95、ANN 对 exact 的召回率、连接池等待和后台建索引对问答的影响，再决定统计缓存、分池或独立检索服务。
6. 给在线问答保留模型预算；将昂贵启动回填变为单 owner 可恢复维护任务；生产迁移与 runtime 权限逐步分离。

不承诺未经测量的性能提升。不因前端文件较大就重写组件，不强制两端路由方案一致，不在没有包体证据时做复杂分包。保留已有文档锁、短事务、响应白名单、密钥加密和检索评估基础。
