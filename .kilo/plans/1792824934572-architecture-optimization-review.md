# 三端架构优化计划评审：问题清单

评审对象：`1792824934572-architecture-optimization.md`
评审日期：2026-10-24
评审方式：对照源码静态核对，未运行测试或复现。

## 一、计划所引证据核对

计划引用的代码位置均已核对，结论属实：

| 计划主张 | 核对结果 |
| --- | --- |
| 管理端 CORS 缺少 PUT | 属实，`apps/api/src/app.ts:39`。本机开发跨域（admin 5176 → API 3001）时，业务模型与 token 的 PUT 会在预检失败 |
| 模型测试可外发密钥 | 属实，且比计划描述更严重（见 P0-1） |
| 敏感路由缺少超级管理员限制 | 属实，`assertSuper` 仅在 `apps/api/src/admin-accounts.ts` 使用 |
| 会话详情无请求身份、任何错误都清除会话 | 属实，`apps/web/src/composables/useChatSession.ts:51-63` |
| 概览 HTTP 与 SSE 写同一状态 | 属实，`apps/admin/src/workspace.ts:27,40`；SSE 回调中 `JSON.parse` 的异常未处理 |
| 先写库后入队的双写窗口、队列检查非原子 | 属实，`apps/api/src/crawl-tasks.ts:10-16`、`apps/api/src/queue.ts:24-27` |
| 自动向量化失败只记日志 | 属实，`apps/worker/src/index.ts:52` |
| 向量检索仅按模型名与维度匹配 | 属实，`packages/processing/src/repository.ts` 的 `vectorSearchChunks` 与摘要召回条件 |
| api-client 测试反向依赖 admin | 属实，`packages/api-client/test/client.test.ts:10` |

## 二、问题清单

### P0-1 普通管理员可将服务端秘密发往任意地址（应作为热修复单独先行）

三条路径：

1. **借用已保存密钥**：`POST /api/admin/model-providers/models` 同时传 `providerId` 与任意 `baseUrl`，服务端用该供应商保存的密钥请求表单地址（`apps/api/src/model-providers.ts:72-79`）。
2. **读取任意环境变量**：传 `credentialEnv: "NYZ_SECRET_KEY"`（或 `DATABASE_URL`、`ADMIN_PASSWORD`、`SMTP_PASS` 等），服务端直接读 `process.env` 并作为 Bearer 头发出（`apps/api/src/model-providers.ts:80`）。另可通过 PATCH 供应商把 `credentialEnv` 持久化为敏感变量，此后 Worker/API 的正常模型调用都会外发。
3. **外发文章 token**：普通管理员可新建指向自有服务器的来源并触发同步，Worker 把全局 nyzdata token 作为查询参数发出（`packages/processing/src/article/client.ts:52`）。

附带问题：`环境变量 X 未设置` 的报错可用于探测环境变量是否存在。

影响：`NYZ_SECRET_KEY` 泄露会使所有已加密密钥失守。

建议：从第一批中拆出「1a 热修复」，仅包含：敏感路由限定超级管理员、模型测试的地址与凭据绑定、`credentialEnv` 白名单（`providerCredential` 读取时和保存供应商时都校验）、删除探测性报错、CORS 补 PUT。审计日志、管理端只读界面、提交锁后移。

### P1-1 权限实现方式易遗漏

计划写「提取共用 `assertSuper`、默认拒绝」，但逐路由手动调用无法保证默认拒绝。

建议：每个 `/api/admin/*` 路由显式声明所需角色（如 Fastify route `config.role`），由统一钩子检查，未声明的一律拒绝；仿照 `test/app.test.ts` 校验 schema 的方式，增加遍历全部管理路由、断言均有权限声明的测试。

### P1-2 权限矩阵不完整

矩阵未覆盖以下路由，需明确归属：

- `PATCH /api/admin/users/:id`（停用用户账号）
- `DELETE /api/admin/documents/:id`

### P2-1 供应商 endpoint 变更判定需细化

计划 1.4「改了 endpoint 须重新提供密钥」：

- 应按 origin（协议 + 主机 + 端口）比较，而不是完整字符串；只改路径（如 `/v1` 与 `/v1/`）不应强制重填。
- `credentialEnv` 的变更同样应视为更换凭据。

### P2-2 禁止重定向的收益被高估

- Node fetch（undici）在跨源重定向时已自动去掉 `Authorization` 头。
- 文章 token 在查询参数中，重定向时不会被带到新地址。

`redirect: "error"` 只是低成本的纵深防御，不是主要修复。部分代理会对结尾斜杠做重定向，启用前需验证现有供应商不受影响。

### P2-3 web 端优先级需调整

- 真正的竞态在 `openSession`：它被 `restoreSession`、侧栏点击、登录切换并发调用，没有请求身份；任何错误（含网络/5xx）都会清除会话。这两点应最先修。
- 连续提交风险较小：`ask()` 在首个 await 前已同步清空 `question`，第二次触发时问题为空会直接返回。可保留，但优先级低。
- 「加载更多历史」属于新功能而非缺陷修正，建议移出第一批，让第一批专注状态正确性。

### P2-4 管理端概览排序方案可简化

SSE 每次推送完整快照，规则可简化为：HTTP 请求发出后，期间若收到任何 SSE 快照，则丢弃该 HTTP 结果；再用 generation 应对退出/重置。无需维护独立的快照序号。

### P2-5 第二批 outbox 方案偏重，应先评估轻量替代

Worker 为 `concurrency: 1` 的单消费者，规模有限：

- 来源互斥：在 `crawl_tasks` 上建部分唯一索引（`source_id`，条件为状态 `等待中`/`运行中`），在数据库层原子互斥；启动时对账，把没有对应队列 job 的「等待中」任务标为失败。可用很小的改动覆盖双写窗口和并发同步问题。
- 向量化重试：自动向量化失败时改为入队带 `attempts`/`backoff` 的 `embed-document`，不再在进程内吞掉错误。改动小，可提前做。

上述手段不足时，再设计完整的 operation/outbox 状态机。

### P3-1 第三批可提前的小步

向量检索条件中加入供应商 ID，成本很低，能先挡住不同供应商同名模型混用向量空间；作为 `embeddingSpaceId` 落地前的过渡。

### P3-2 文字与细节

- 第一批 4.3「为两端测试增加独立类型检查入口」：web/admin 已有 `test` 脚本，实际所指应为测试文件未被 `vue-tsc` 覆盖，需写明。
- 上线前清点 `credentialEnv`，给出只读 SQL：`SELECT id, name, base_url, credential_env FROM model_providers WHERE credential_env <> ''`。
- 审计日志的 requestId 直接使用 Fastify 自带的 `request.id`，不另行生成。

## 三、建议的实施顺序

1. **1a 热修复**：CORS 补 PUT；敏感路由限定超级管理员（统一钩子 + 遍历测试）；模型测试的地址与凭据绑定；`credentialEnv` 白名单；删除探测性报错。
2. **1b**：审计日志；管理端只读/禁用状态；供应商编辑时的凭据规则。
3. **1c**：web 端 `openSession` / 历史列表的请求身份与错误分类；admin 概览与表单的生命周期。
4. **1d**：契约测试与测试目录调整（AdminApiClient 测试迁回 admin 等）。
5. **第二批之前**：先试部分唯一索引 + 启动对账 + 向量化走队列重试，效果不够再上 outbox。
