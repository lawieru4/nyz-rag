# 微信小程序开发计划

编制日期：2026-10-27  
涉及范围：`apps/weixin`（新增）、`apps/api`（身份与微信登录）、`packages/api-client`、`packages/types`  
文档状态：待实施。现状依据 2026-10-27 的代码梳理，没有经过真机验证。

已确定（2026-10-27）：UI 组件库用 **wot-design-uni**；小程序身份用**请求头令牌**（第 4.2、5.1 节）；正式 API 域名为 **`https://ragapi.baolinfeng.cn`**；微信用户采用「账号表 + 第三方身份表」（第 5.2 节）。

## 1. 目标与边界

### 1.1 目标

在微信小程序里提供与用户端 Web（`apps/web`）对等的文章问答能力：提问、流式回答、查看引用、阅读文章、管理会话、账号登录，并补上小程序特有的微信登录与分享。

### 1.2 本期范围

- 只做用户端，不做管理端。管理端继续用 Web（`apps/admin`）。
- 只做微信小程序（`mp-weixin`），uni-app 的其他平台（H5、App、其他小程序）不验收。
- 复用现有接口。确有必要的接口改动集中在身份传递与微信登录（第 5 节）。

### 1.3 现状

| 项 | 现状 |
| --- | --- |
| 工程 | `apps/weixin` 是 uni-app Vue 3 + Vite 的官方模板：只有 `pages/index/index` 一个页面，没有请求 API 的代码 |
| 依赖版本 | `@dcloudio/*` 3.0.0-5020620260917001、`vite` 5.2.8、`typescript` ^4.9、`vue-tsc` ^1，比工作区其他包旧，由 uni-app 锁定 |
| 脚本 | 有 `dev`（`uni -p mp-weixin`，已加入根目录 `pnpm dev`），但没有 `build`、`typecheck`、`test`，所以 `pnpm build`、`pnpm typecheck` 和 `pnpm test` 都不会覆盖它 |
| 配置 | `manifest.json` 的 `mp-weixin.appid` 为空，`urlCheck: false`；`app-plus` 等其他平台的配置是模板自带的，用不到 |
| 部署 | 不在 `docker-compose.yml` 中。小程序是代码包，用微信开发者工具上传，不需要容器 |

## 2. 功能模块

优先级：P0 为首个可用版本必须有，P1 为正式上线前完成，P2 为后续迭代。

### 2.1 页面结构

```
pages/
  chat/index          问答首页（tabBar）：当前会话、输入区、检索范围
  sessions/index      会话列表（tabBar 或首页抽屉）：历史会话、新建、删除
  article/index       文章详情：?id=<documentId>，可分享
  mine/index          我的（tabBar）：登录状态、账号操作、关于与隐私
  auth/login          登录 / 注册 / 找回密码（邮箱验证码）
  auth/password       修改密码
  webview/index       （P2）打开原文外链，需配置业务域名
components/
  ChatTurn            单轮问答：问题、回答、来源、操作栏
  AnswerMarkdown      回答 Markdown 渲染，[n] 渲染为可点的引用
  MarkdownBlocks      文章正文渲染（与回答共用解析结果）
  SourceSheet         引用来源底部弹层：标题、转载源、片段摘录、查看全文
  FilterSheet         检索范围弹层：发布日期、分类、标签、场景
  FeedbackBar         有帮助 / 需要改进 + 原因
```

### 2.2 模块清单

| 模块 | 功能点 | 接口 | 优先级 |
| --- | --- | --- | --- |
| **A. 问答** | 输入问题并发送；流式显示回答（`token` 事件逐段追加，以 `done` 事件的回答为准） | `POST /api/chat/sessions`（首问时建会话）、`POST /api/chat/sessions/:id/stream` | P0 |
| | 停止生成：中止请求，提示“已停止生成，本轮回答未保存” | 同上（`RequestTask.abort()`） | P0 |
| | 连接中断（没有收到 `done`）：提示本轮未保存，可以重试 | 同上 | P0 |
| | 重新生成：只限最后一轮，`{ regenerate: messageId }` | 同上 | P0 |
| | 复制回答（`uni.setClipboardData`） | 无 | P0 |
| | 空状态：知识库统计、示例问题 | `GET /api/knowledge` | P1 |
| | 回答为原文摘录（`answerMode: "extractive"`）时显示轻提示 | 无 | P1 |
| | 限流（429）、服务不可用（503）的友好提示 | 无 | P0 |
| **B. 引用来源** | 回答中的 `[n]` 可以点，打开对应来源的底部弹层 | 无（来自 `source` 事件 / 会话消息） | P0 |
| | 来源列表：标题、转载源、送入模型的片段摘录（`excerpts`） | 同上 | P0 |
| | 从来源跳转文章详情 | 无 | P0 |
| **C. 检索范围** | 发布日期起止、分类、标签、场景（逗号分隔），显示已选数量，一键清除 | 随问答请求的 `filters` 提交 | P1 |
| **D. 反馈** | 有帮助 / 需要改进，可以撤销；需要改进时可多选原因（证据不足、回答错误、引用不符、内容过时、其他） | `POST /api/messages/:id/feedback` | P1 |
| **E. 会话** | 会话列表（分页、按更新时间排序），切换会话并加载历史消息与来源 | `GET /api/chat/sessions`、`GET /api/chat/sessions/:id/messages` | P0 |
| | 新建会话、删除会话（二次确认） | `POST /api/chat/sessions`、`DELETE /api/chat/sessions/:id` | P0 |
| | 记住最后打开的会话（`uni.setStorageSync`）；只有 404/400 才清除，临时错误保留，规则同 Web 的 `useChatSession` | 无 | P1 |
| **F. 文章详情** | 标题、元信息（发布时间、转载源等）、Markdown 正文（标题、段落、列表、代码、表格） | `GET /api/documents/:id` | P0 |
| | 分享给好友 / 朋友圈（`onShareAppMessage` / `onShareTimeline`），落地页就是文章详情 | 无 | P1 |
| | 文章不存在（404）的空状态 | 同上 | P0 |
| **G. 身份与账号** | 匿名访客：首次启动由服务端分配访客身份，可以直接提问 | 第 5.1 节 | P0 |
| | 邮箱登录、注册（6 位验证码）、找回密码、修改密码、退出 | `/api/auth/*` | P1 |
| | 微信一键登录（`wx.login` 换取 openid），登录后把访客数据归入账号 | 新增 `POST /api/auth/wechat/login`（第 5.2 节） | P1 |
| | 已有邮箱账号绑定微信 | 新增接口 | P2 |
| **H. 合规与设置** | 用户协议、隐私政策页；首次使用的隐私授权（基础库隐私保护指引） | 无 | P1（上线必需） |
| | 关于、版本号、意见反馈入口 | 无 | P2 |
| **I. 体验** | 下拉刷新会话列表、上拉加载更多；安全区适配（底部输入区）；键盘弹出时输入区上移 | 无 | P1 |
| | 网络状态监听，离线时禁止提问 | 无 | P2 |

> 用户端 Web 目前没有用 `POST /api/search`，小程序也先不做单独的搜索页（P2 再评估）。

## 3. 技术选型

### 3.1 结论

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 框架 | **uni-app（Vue 3 + Vite + TypeScript）**，沿用 `apps/weixin` 现有脚手架 | 和 web/admin 同为 Vue 3 组合式 API，`useChatSession` 的状态逻辑、Markdown 解析可以移植或共用；不选原生小程序和 Taro，避免引入第二套组件写法 |
| 编译目标 | 只用 `mp-weixin` | 精简 `package.json` 中其他平台的依赖和脚本（是否删除另行确认） |
| UI 组件 | **wot-design-uni**（已确定） | Vue 3 + TS，有弹出层（Popup / ActionSheet）、表单、Toast、MessageBox、Tabbar、空状态等；`@nyz-rag/ui`（reka-ui）依赖 DOM，小程序里不能用。在 `pages.json` 用 `easycom` 按需引入，需要 `sass`；主题用它的 ConfigProvider / CSS 变量对齐 `packages/ui` 的配色 |
| 样式 | **SCSS + CSS 变量**（主题色抄 `packages/ui` 的 `theme.css`），单位用 `rpx` | 不引入 Tailwind（`weapp-tailwindcss`），组件库已覆盖大部分样式需要 |
| 状态管理 | 组合式函数（composables）+ `uni.setStorageSync` | 状态只有会话和身份两块，不需要 Pinia；以后跨页面共享状态变多了再考虑 |
| 网络 | 封装 `uni.request`（普通请求）与 `wx.request` 的分块传输（流式，第 4.1 节） | 小程序没有 `fetch`、`Headers`、`ReadableStream`、`TextDecoder`，`@nyz-rag/api-client` 的 `ApiClient` 不能直接用 |
| 类型 | `@nyz-rag/types`（只做类型导入） | 和 API 共用接口类型，修改接口时先改这里 |
| Markdown | 复用 `apps/web/src/markdown.ts` 的 `parseMarkdown`（纯函数，输出块结构），用 Vue 组件渲染 | 不用 `rich-text` / `v-html`：回答中的 `[n]` 要绑定点击事件，`rich-text` 做不到；也不引入 towxml、mp-html 这类较重的库 |
| 测试 | 纯逻辑（SSE 解析、UTF-8 解码、Markdown、身份存储）用 Node 内置 test runner；页面靠开发者工具和真机手动验收 | 与仓库其他包一致 |

### 3.2 代码共用方式

| 内容 | 现在位置 | 处理 |
| --- | --- | --- |
| 接口类型 | `packages/types` | 直接引用 |
| `ApiError`、`errorMessage` | `packages/api-client/src/client.ts` | 直接引用（与运行环境无关） |
| SSE 分块解析 | `api-client` 的 `readSseEvents`（依赖 `ReadableStream`、`TextDecoder`） | 抽出与运行环境无关的纯函数 `parseSseBuffer(buffer) → { events, rest }`，Web 与小程序共用；补充测试 |
| Markdown 解析 | `apps/web/src/markdown.ts` | 移到共享位置（新建 `packages/markdown`，或并入 `packages/api-client`，**方案待定**），web 与 weixin 共用 |
| 会话状态 | `apps/web/src/composables/useChatSession.ts`（依赖 `ApiClient.stream`、`localStorage`） | 小程序端照同样的规则另写一份（注入请求与存储），不强求共用 |

注意 web/admin/api-client 的源码限制：只能用可擦除的 TypeScript 语法，包内导入写 `.ts` 扩展名。抽到共享包的代码同样要遵守，还要保证 uni-app 的 Vite 5 能解析 `.ts` 扩展名导入（需验证）。

## 4. 关键技术问题

### 4.1 流式回答（SSE）

小程序没有 `EventSource` 和 `fetch` 流。方案如下：

1. `wx.request({ enableChunked: true, responseType: "arraybuffer" })`，在 `requestTask.onChunkReceived` 中收到 `ArrayBuffer` 分块（要求基础库 2.20.2 及以上，`project.config.json` / 后台设置最低基础库版本）。用 uni-app 时，确认 `uni.request` 是否会透传 `enableChunked` 并返回 `onChunkReceived`；不行就用条件编译直接调 `wx.request`。
2. **UTF-8 解码**：一个汉字可能被拆到两个分块里，部分基础库没有 `TextDecoder`，需要自写增量 UTF-8 解码器，把不完整的尾部字节留到下一块。
3. 把解码后的文本交给共用的 `parseSseBuffer`：跳过 `: ping` 心跳，按 `\n\n` 分事件，处理 `source` / `token` / `done` / `error`。
4. 停止生成用 `requestTask.abort()`。服务端检测到断开会中止模型调用、不保存，和 Web 一致。
5. **部署注意**：反向代理要关闭缓冲（Nginx `proxy_buffering off`，或响应头 `X-Accel-Buffering: no`），否则分块会被攒到结束才下发；`docker/nginx.conf` 的 `/api/` 代理需要检查。
6. **降级**：真机上分块不可用（基础库过低、个别机型）时，等整条响应结束后一次性解析，体验上相当于“非流式”，但会话与记录逻辑不变。

需要真机验证：iOS / Android 的分块粒度、长回答（>4000 字）、弱网、切到后台再回来时的请求状态。

### 4.2 身份传递

现在的用户端身份完全依赖 Cookie：`nyz_user_session`（登录会话）与 `nyz_visitor`（匿名访客），属性为 `HttpOnly; SameSite=Strict; Path=/api`；非 GET 请求必须带 `X-NYZ-Client: 1`。

小程序的 `wx.request` 不会自动保存和发送 Cookie。**已确定用请求头令牌**，不手动维护 Cookie：

- 后端在 `user-auth.ts` 中，除了 Cookie，还支持 `Authorization: Bearer <会话令牌>` 与 `X-NYZ-Visitor: <访客令牌>`；签发令牌时，对 `X-NYZ-Client: mp` 的请求用响应头返回令牌。约定见第 5.1 节。
- 令牌存在小程序 Storage（`uni.setStorageSync`）中，不是 HttpOnly。所以服务端照样可以让令牌失效：会话 30 天过期，修改密码、停用账号时提升 `session_version`，退出时删除 Redis 会话。
- 请求头令牌不会被浏览器自动携带，没有 CSRF 风险。但 `X-NYZ-Client` 仍然必须带，用来区分客户端：`1` 为 Web，`mp` 为小程序。
- `WEB_ORIGINS` 只约束浏览器跨域。小程序请求不带浏览器 `Origin`，不受它影响，不用改。

### 4.3 网络与域名

- 开发：开发者工具勾选“不校验合法域名”（`manifest.json` 已设 `urlCheck: false`），可以访问 `http://127.0.0.1:3001`；真机预览需要局域网 IP 或内网穿透，并打开调试模式。
- 正式：API 地址为 **`https://ragapi.baolinfeng.cn`**。需要：
  - 在小程序后台把它配置为 **request 合法域名**；域名要已 ICP 备案，证书链完整，支持 TLS 1.2 及以上；
  - 打开原文外链（`webview`）时还要配置**业务域名**（需在域名根目录放校验文件）；
  - 该子域名专供 nyz-rag API，反向代理把 `/api/` 转发到 API 服务（容器方式为 `127.0.0.1:${API_PORT}`）；
  - 反向代理对流式接口关闭缓冲（第 4.1 节）。
- API 地址的注入：
  - 在 `apps/weixin` 下放 `.env.development`（`VITE_API_URL=http://127.0.0.1:3001`）和 `.env.production`（`VITE_API_URL=https://ragapi.baolinfeng.cn`）；
  - 不与根目录 `.env` 共用，因为根目录的 `.env` 有密钥，小程序代码包会被下载，只能放公开信息；
  - `dev` 默认读取 development，`build` 默认读取 production。

### 4.4 Markdown 与引用渲染

- 解析用共享的 `parseMarkdown`，得到标题、段落、列表、代码、表格五种块；行内的 `[n]` 拆成文本片段与引用片段，引用片段渲染为可点的 `<text>`。
- 表格、代码块放在 `scroll-view scroll-x` 里横向滚动。
- 流式期间每收到一个 token 就整段重新解析，回答很长时可能卡顿：按 50～100 ms 节流刷新（参考 Web 的 `smoothText.ts`）。

### 4.5 合规（上线前必须确认）

- **生成式 AI 服务资质**：小程序提供 AI 问答，需要确认服务类目与资质要求（如所用大模型的备案信息、深度合成相关材料），以微信审核规则为准。**这是上线的前置条件，需要尽早确认**。
- **内容安全**：建议用 `msgSecCheck`（内容安全接口）检查用户提问，必要时也检查回答；它需要服务端维护 `access_token`（缓存在 Redis）。
- **隐私**：后台填写《用户隐私保护指引》（收集邮箱、提问内容、微信 openid），小程序内做隐私授权弹窗；用户协议与隐私政策页面要能访问到。

## 5. 后端改动

按第 4 节的结论，需要改动的后端接口如下。每项都要同步 `packages/types`、`apps/api/src/schemas.ts`（路由与 schema 一一对应）与契约测试。

### 5.1 请求头令牌（P0，M1 前完成）

令牌本身与 Cookie 中的值相同（32 字节随机数的十六进制），Redis 会话、`session_version` 校验、访客只存 SHA-256 这些逻辑都不变，只多一种传递方式。

**请求头**（小程序每个请求都带）：

| 请求头 | 值 | 说明 |
| --- | --- | --- |
| `X-NYZ-Client` | `mp` | 标识小程序；`user-auth.ts` 现在只接受 `1`，要放宽为 `1` 或 `mp` |
| `Authorization` | `Bearer <会话令牌>` | 已登录时带；等同于 `nyz_user_session` Cookie |
| `X-NYZ-Visitor` | `<访客令牌>` | 未登录时带；等同于 `nyz_visitor` Cookie |

**响应头**（只对 `X-NYZ-Client: mp` 的请求返回，Web 仍然用 `Set-Cookie`）：

| 响应头 | 何时返回 | 小程序处理 |
| --- | --- | --- |
| `X-NYZ-Session-Token` | 登录、注册、重置密码、微信登录成功 | 存起来，同时删除访客令牌 |
| `X-NYZ-Visitor-Token` | 没有有效令牌时分配了新访客 | 存起来 |
| `X-NYZ-Session-Token: ` 空值 | 会话失效（过期、改密码、停用）或退出 | 删除会话令牌，下一次请求会分配新访客 |

实现要点：

- `onRequest` 钩子中，令牌的来源顺序为：`Authorization` → Cookie；访客同样先取请求头再取 Cookie。`requestOwner` 与 `claimVisitorData` 不变。
- 流式接口 `hijack` 后会把 `reply` 上已有的响应头复制到原始响应，所以分配访客的响应头也能带出。但小程序**启动时要先串行调用 `GET /api/auth/session`** 拿到访客令牌，再发其他请求，否则并发请求会各自分配一个访客。
- 用 `wx.request` 的分块模式时，响应头在 `onHeadersReceived` 中读取。
- 令牌是认证凭据，不写入日志（Fastify 默认不记请求头，新增日志时注意）。
- 测试（`apps/api/test`）：令牌头取得身份与归属、分配访客、登录后归并访客数据、会话失效时清除、`X-NYZ-Client` 缺失时返回 403，以及 Cookie 方式不受影响。

### 5.2 微信登录与用户表（P1）

参照常见的「账号表 + 第三方身份表（`user_auths` / `user_identities`）」设计：`users` 只放账号本身，登录方式放在身份表里，一个账号可以同时有邮箱和微信两种登录方式，以后接其他登录也不用改 `users`。

**微信侧前提**：

- 登录流程：小程序 `wx.login()` 得到 `code`（5 分钟有效、只能用一次）→ 服务端调用 `GET https://api.weixin.qq.com/sns/jscode2session?appid=&secret=&js_code=&grant_type=authorization_code` → 得到 `openid`、`session_key`，绑定了微信开放平台时还有 `unionid`。
- `openid` 只在同一个小程序（appid）内唯一；`unionid` 在同一开放平台主体下的多个应用间唯一，所以表里同时存 `app_id` 与 `union_id`。
- `session_key` 只在解密 `wx.getUserInfo` 等加密数据时才用到。手机号用 `getPhoneNumber` 返回的 `code` 换取，不需要它，**不保存** `session_key`。
- `wx.getUserProfile` 已经不再返回真实昵称与头像。需要时用「头像昵称填写能力」（`<button open-type="chooseAvatar">` + `<input type="nickname">`）让用户主动填写，本期不做（P2，头像还需要文件存储）。

**表结构**（Drizzle，`packages/processing/src/schema.ts`）：

```ts
// users：email、password_hash 改为可空，只用微信登录的账号没有邮箱和密码。
//   users_email_idx 保持唯一（PostgreSQL 唯一索引允许多个 NULL）。
//   另加 display_name（可空，P2 的昵称）。

export const userIdentities = pgTable("user_identities", {
  id: text().primaryKey(),
  userId: text().notNull().references(() => users.id, { onDelete: "cascade" }),
  // 登录方式：目前只有 wechat_mp（微信小程序）；邮箱密码仍在 users 上。
  provider: text().notNull(),
  // 应用标识：小程序 appid；openid 只在同一 appid 内唯一。
  appId: text().notNull(),
  // 该应用下的用户标识（openid）。
  subject: text().notNull(),
  // 开放平台 unionid，没有绑定开放平台时为空；以后接公众号 / App 时按它关联同一账号。
  unionId: text(),
  lastLoginAt: timestamptz(),
  createdAt: timestamptz().notNull().defaultNow(),
  updatedAt: timestamptz().notNull().defaultNow(),
}, (table) => [
  uniqueIndex("user_identities_subject_idx").on(table.provider, table.appId, table.subject),
  // 一个账号在同一应用下只绑定一个微信。
  uniqueIndex("user_identities_user_idx").on(table.userId, table.provider, table.appId),
  index("user_identities_union_idx").on(table.unionId).where(sql`${table.unionId} is not null`),
  check("user_identities_provider_check", sql`${table.provider} in ('wechat_mp')`),
]);
```

改完运行 `pnpm db:generate`。新表要在 `restore-drill.ts` 的 `TABLE_RECOVERY` 中归类，并同步 `docs/backup-restore.md` 第一节。

**接口**：

| 接口 | 说明 |
| --- | --- |
| `POST /api/auth/wechat/login` `{ code }` | 换取 openid → 按 `(wechat_mp, appid, openid)` 查身份：有则登录该账号（已停用返回 403）；没有则在同一事务中创建 `users`（无邮箱、无密码）与 `user_identities`。然后归并当前访客数据（`claimVisitorData`）、记录登录时间、签发会话令牌。响应同登录接口（`UserSessionResponse`），令牌在响应头。 |
| `POST /api/auth/wechat/bind` `{ code }`（P2） | 已登录的邮箱账号绑定微信；该微信已属于其他账号时返回 409 |
| `POST /api/auth/email/bind`（P2） | 只用微信登录的账号绑定邮箱并设置密码（邮件验证码），之后可以在 Web 上登录 |

微信接口错误的处理：

| 情况 | 返回 |
| --- | --- |
| `errcode` 40029（code 无效）、40163（code 已使用） | 400「登录已过期，请重试」 |
| 45011（频率限制） | 429 |
| -1（系统繁忙）、网络错误、超时 | 503 |
| 未配置 `WECHAT_MP_APPID` / `WECHAT_MP_SECRET` | 503，提示微信登录未开启 |

实现要点：

- 配置项 `WECHAT_MP_APPID`、`WECHAT_MP_SECRET` 放在根目录 `.env`（不加 `VITE_` 前缀），同步到 `.env.example`；`secret` 不写入日志和错误信息。
- 调用 `jscode2session` 的客户端由 `buildApp({ wechat })` 注入，测试用假实现，不访问外网（与 `mailer`、`users` 的注入方式一致）。
- 按 IP 限流，复用登录接口的限流逻辑。
- 不在日志里记录 `code`、`session_key`、`openid` 原文。

**其他受影响的地方**（`users.email` 与 `password_hash` 变为可空后）：

- `@nyz-rag/types`：`UserAccount.email` 改为可空，新增 `loginMethods: ("email" | "wechat")[]`；Web 账号菜单与管理端用户列表要处理没有邮箱的账号。
- 邮箱登录：账号没有密码时按密码错误处理（照常用 `dummyPasswordHash` 比对，避免通过响应时间探测账号）。
- 修改密码：没有密码的账号返回 400，提示先绑定邮箱。找回密码按邮箱查找，不受影响。
- 停用账号、`session_version` 失效机制对两种登录方式同样适用。
- 管理端「用户管理」显示登录方式；按邮箱搜索不变，可以增加按「微信用户」筛选。

### 5.3 内容安全（P1，视合规结论而定）

- 在 `POST /api/chat/sessions/:id/stream` 与 `POST /api/chat` 入口调用 `msgSecCheck`（只对 `X-NYZ-Client: mp` 的请求，或全部请求），不通过返回 400 和统一提示。
- `access_token` 按有效期缓存在 Redis（键前缀沿用 `<DOCUMENT_QUEUE_NAME>:`），失败时的策略（放行或拒绝）**待定**。

## 6. 工程化

- `apps/weixin/package.json`：
  - 增加 `build`（`uni build -p mp-weixin`）、`typecheck`（`vue-tsc --noEmit`）和 `test`（Node test runner 跑纯逻辑），纳入 `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm verify`；
  - 升级 `typescript`、`vue-tsc` 与工作区一致前，先确认 uni-app 的兼容性。
- 新增 `project.config.json`（或由 `manifest.json` 生成），设置 `appid` 与最低基础库版本。`appid` 不算密钥，但每个开发者的测试号不同，是否入库**待定**。
- CI：`verify` 任务会跑小程序的构建与类型检查；上传（`miniprogram-ci`）需要上传密钥，暂不放进 CI。
- 文档：更新 `README.md`、`CLAUDE.md` 的命令与架构说明，以及 `docs/module-status.md`。

## 7. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 工程准备 | 安装 wot-design-uni 与 `sass` 并配置 `easycom`；脚本接入 `pnpm verify`；`.env.development` / `.env.production`；请求封装（令牌头、`ApiError`）；抽出共享的 SSE 解析与 Markdown 解析（含测试）；后端请求头令牌（第 5.1 节，含契约测试） | `pnpm verify` 通过；开发者工具中启动后拿到访客令牌，能请求 `GET /api/knowledge` |
| M1 问答闭环（P0） | 问答页（流式、停止、重新生成、复制）；引用弹层；文章详情；会话列表 / 切换 / 新建 / 删除 | 开发者工具和至少一台 iOS、一台 Android 真机：完整问答、停止、断网提示、长回答、引用跳转；重启小程序后会话仍在 |
| M2 账号与体验（P1） | 微信登录（`user_identities` 迁移、接口与测试）；邮箱账号流程；检索范围；反馈；分享；安全区与键盘；隐私授权 | 访客 → 微信登录后历史会话保留；退出后变为新访客；管理端能看到微信用户并停用；分享卡片能打开文章 |
| M3 上线准备 | 合规材料与类目；内容安全；`ragapi.baolinfeng.cn` 配置为合法域名、反向代理关闭流式接口缓冲；体验版测试 | 体验版通过真机走查（正式域名）；提交审核 |

## 8. 待确认事项

已确定：UI 组件库 wot-design-uni；请求头令牌；正式 API 域名 `https://ragapi.baolinfeng.cn`；微信用户用 `user_identities` 身份表。

仍待确认：

1. `ragapi.baolinfeng.cn` 的 ICP 备案与 HTTPS 证书是否就绪。
2. 小程序 AppID（`manifest.json`）与 AppSecret（`WECHAT_MP_SECRET`），以及是否绑定了微信开放平台（决定有没有 `unionid`）。
3. 小程序的主体、类目和生成式 AI 资质；是否接内容安全接口，以及接口失败时的策略。
4. 只用微信登录的账号绑定邮箱 / 已有邮箱账号绑定微信（P2）是否要做。
5. Markdown 解析共享包的位置。
6. 是否精简 uni-app 模板中用不到的多平台依赖。
