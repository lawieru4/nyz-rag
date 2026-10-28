# 备份与恢复

需要备份的只有两样：PostgreSQL 业务库（`nyzrag` 库的 `public` schema）和主密钥 `NYZ_SECRET_KEY`。Redis 不备份（第五节）。恢复是否可用以演练为准：`pnpm db:restore-drill` 把备份恢复到临时库并逐项检查（第三节）。

## 一、哪些数据丢了能重建

所有业务数据都在 PostgreSQL。下表按「丢失后能否找回」划分，演练脚本按同样的分类输出行数（`packages/processing/src/restore-drill.ts` 的 `TABLE_RECOVERY`，新增表时须归类，测试会检查）。

| 类别 | 表 | 丢失后 |
| --- | --- | --- |
| 不能重建 | `admin_accounts`、`admin_roles`、`admin_audit_logs` | 管理员账号、角色与操作日志全部丢失。启动时只会按 `ADMIN_EMAIL`/`ADMIN_PASSWORD` 重新建一个超级管理员 |
| 不能重建 | `users` | 用户端账号丢失，用户须重新注册；他们的会话与问答随之找不回 |
| 不能重建 | `chat_sessions`、`chat_messages`、`message_sources`、`message_chunks` | 问答记录、反馈、人工审核结论、降级原因与召回片段丢失，问答统计与评估回归失去依据 |
| 不能重建 | `model_providers`、`model_settings`、`secret_settings` | 供应商、业务模型选择与加密保存的密钥（模型 API Key、nyzdata token）丢失，需在管理端重新填写；手里没有原密钥就无法恢复 |
| 不能重建 | `knowledge_bases`、`data_sources` | 检索参数、提示词与来源配置需重新录入；来源的同步游标（`sync_state`）丢失后下次同步从头回填 |
| 可重新同步 | `documents` | 可重新创建来源后从文章接口全量同步，但上游已删除、下架或变为无权限（VIP）的文章找不回；原始详情 `raw_json` 是重新解析的依据 |
| 可从文章重建 | `document_chunks`、`document_sections` | 由 `documents.raw_json` 重新处理（解析、切片、向量化）得到，向量化要重新调用 Embedding，按文章量产生费用和耗时；没有批量入口，需逐篇「重新处理」 |
| 运行记录 | `operations`、`crawl_tasks` | 后台操作与同步任务的历史；丢失时进行中的同步、重新处理与向量化不会继续，需在管理端重新发起 |

另外 `__drizzle_migrations` 记录已执行的迁移，必须和数据一起备份，否则启动时会把迁移从头再执行一遍而失败。

结论：**整库备份，不要用 `--exclude-table-data` 省掉切片表**。切片与向量虽然占了大部分体积，但重建需要逐篇重新处理并重新付费向量化；只备份文章而不备份切片时，恢复出的文档仍标记为已向量化却没有切片，检索会直接缺内容（演练会把这种备份判为不通过）。

不需要备份的：

- 评估实验 schema（`eval_*`，由 `pnpm evaluate:index` 从业务库复制后重新切片、向量化），备份时排除；本地业务库中它们约占一半体积。需要时重新生成（调用 Embedding，产生费用）。
- `.nyz-data/` 下的评估工作文件与运行记录不在数据库里，按需自行保留，与本文的恢复无关。

## 二、备份

### PostgreSQL

用 `pg_dump` 的自定义格式（压缩、可选择性恢复），以应用账号执行即可；`pg_dump` 版本不能低于数据库服务（当前为 PostgreSQL 18）。`pg_dump` 在一个快照内导出，API 与 Worker 不必停机。

```sh
pg_dump --format=custom --exclude-schema='eval_*' \
  --file="nyzrag-$(date +%Y%m%d-%H%M%S).dump" "$DATABASE_URL"
```

本机没有 PostgreSQL 18 客户端时，用数据库容器里的 `pg_dump`（`<容器>` 为数据库容器名，标准输出重定向到宿主机文件）：

```sh
export PGPASSWORD='<nyzrag 账号密码>'
docker exec -e PGPASSWORD <容器> pg_dump --format=custom --exclude-schema='eval_*' \
  -U nyzrag -d nyzrag > "nyzrag-$(date +%Y%m%d-%H%M%S).dump"
```

建议每天备份一次，保留最近 7 天和最近 4 周各一份，并复制一份到数据库服务器以外的位置。备份文件包含用户邮箱、密码散列（scrypt）、问答内容与加密后的密钥，按敏感数据保管。

### NYZ_SECRET_KEY 必须单独备份

模型 API Key 和 nyzdata token 在库中只有 AES-256-GCM 密文（`secrets.ts`），主密钥是环境变量 `NYZ_SECRET_KEY`，不在数据库里，pg_dump 不会带上它：

- 丢了主密钥：备份能恢复，但已保存的密钥全部无法解密（管理端提示重新填写），模型调用与文章同步在重新填写前不可用。其余数据不受影响。
- 主密钥要和备份**分开存放**（如密码管理器或部署平台的密钥管理），不要放进备份文件所在的位置；两者一起泄露等于泄露全部密钥。
- 更换主密钥后，旧备份里的密文只能用旧主密钥解开。更换前留存旧主密钥，或更换后立即重新备份。

演练脚本会用当前环境中的 `NYZ_SECRET_KEY` 逐个解密备份中的密钥，用它确认留存的主密钥与备份匹配。

## 三、恢复演练

```sh
NYZ_RESTORE_ADMIN_URL='postgresql://<超级用户>:<密码>@<主机>:<端口>/postgres' \
  pnpm db:restore-drill --dump=nyzrag-20261027-120000.dump
```

脚本（`packages/processing/src/cli/restore-drill.ts`）依次：

1. 新建临时库 `nyzrag_restore_drill_<时间>_<随机>`，用 `pg_restore` 恢复备份（单事务，出错即停）。
2. 核对迁移记录：按 `created_at` 与当前代码的迁移日志比较（与 drizzle 的判断一致，不比较随换行符变化的 hash）。备份之后新增的迁移只提示，启动时会自动执行；备份中有当前代码没有的迁移（备份来自更新的版本），或缺少早于最后一条记录的迁移时判为不通过。
3. 按第一节的分类输出各表行数；备份中没有超级管理员时提示。
4. 检查已向量化的文档是否都有对应数量的带向量切片。
5. 用当前 `NYZ_SECRET_KEY` 解密备份中的每个密钥（模型供应商密钥、`secret_settings`），只输出能否解开，不输出明文。
6. 删除临时库（中途失败或按 Ctrl+C 中断同样删除；删除失败时输出需手动执行的 SQL）。

任一项不通过时退出码为 1。

注意事项：

- 脚本**不连接 `DATABASE_URL`**，不读写业务库；临时库只能是上述名称，脚本不会删除其他库。
- `NYZ_RESTORE_ADMIN_URL` 的账号需要能建库并创建 `vector` 扩展（pgvector 不是受信任扩展），通常为超级用户；应用账号 `nyzrag` 没有这些权限。演练库可以在业务库所在的实例上（本地为共用基础设施的超级用户 `postgres@localhost:5432`），也可以是单独的一台。临时库需要与业务库相当的磁盘空间。
- 校验密钥用的是运行脚本时环境中的 `NYZ_SECRET_KEY`（`.env` 中的值不会覆盖已设置的环境变量）。要验证留存的那份主密钥，就在命令前显式设置它。
- 本机没有版本合适的 `pg_restore` 时，用演练库所在容器里的：`--pg-restore="docker exec -i -e PGUSER -e PGPASSWORD <容器> pg_restore"`。脚本把账号、密码放在环境变量里传给 `pg_restore`（`docker exec -e` 转入容器），容器内经本地套接字连接，因此该容器必须就是 `NYZ_RESTORE_ADMIN_URL` 指向的数据库服务。
- 建议每月演练一次，以及升级包含迁移的版本之前演练一次最近的备份。

## 四、正式恢复

1. 停止 API 与 Worker（`docker compose stop api worker`，或停掉本机进程），避免恢复期间写入或执行迁移。
2. 由数据库管理员准备空库：删除（或改名保留）损坏的库，新建归应用账号所有的同名库，并在 `public` 中创建扩展：

   ```sql
   CREATE DATABASE nyzrag OWNER nyzrag;
   \c nyzrag
   CREATE EXTENSION vector;
   ```

3. 以应用账号恢复。应用账号不是扩展的所有者，备份中的 `CREATE EXTENSION` 与 `COMMENT ON EXTENSION` 两条要跳过，否则会因权限不足中止：

   ```sh
   pg_restore --list nyzrag-20261027-120000.dump | grep -vE 'EXTENSION - vector|COMMENT - EXTENSION vector' > restore.list
   pg_restore --use-list=restore.list --no-owner --no-privileges --exit-on-error --single-transaction \
     --dbname="$DATABASE_URL" nyzrag-20261027-120000.dump
   ```

4. 用与备份时相同的 `NYZ_SECRET_KEY` 启动 API 与 Worker；启动时会执行备份之后新增的迁移。主密钥已丢失时照常启动，然后在管理端重新填写模型 API Key 与 nyzdata token。
5. 恢复后：
   - 备份之后的数据（问答、账号、配置变更）已丢失，需要告知相关人员。
   - 备份时正在执行或排队的后台操作由 Worker 接续：执行中的在租约过期后重新执行，已投递而队列中没有对应任务的重新投递。
   - 来源的同步游标回到备份时的位置，在管理端对文章来源手动同步一次，补回备份之后上游新增或修改的文章。

## 五、Redis 不备份

Redis 中只有可以丢失的运行时数据，键都以 `DOCUMENT_QUEUE_NAME` 为前缀（BullMQ 队列为 `bull:<DOCUMENT_QUEUE_NAME>:`）：

| 内容 | 丢失后 |
| --- | --- |
| BullMQ 队列中的任务 | 后台操作的状态在 PostgreSQL 的 `operations` 表中，队列只是投递通道。Worker 的投递器每 1/4 租约检查一次：已投递超过一个租约（默认 60 秒）仍未开始、队列中又没有对应任务的操作重新入队；执行中的操作在租约过期后回到等待并重新执行；尚未投递的操作照常投递。无需人工处理 |
| 管理员会话（8 小时） | 已登录的管理员需重新登录 |
| 用户端登录会话（30 天） | 已登录的用户需重新登录；匿名访客的身份在浏览器 Cookie 与数据库的 `visitor_hash` 中，不受影响 |
| 注册、找回密码的邮件验证码（10 分钟） | 未使用的验证码失效，用户重新获取 |
| 登录限流、接口与问答限流、模型调用准入的计数 | 计数清零，限流窗口重新开始 |

Redis 不可用期间 API 的管理端、用户端登录与限流会拒绝请求（`/ready` 返回 503），恢复后自动可用。共享 Redis 上不要为此执行 `FLUSHALL`/`FLUSHDB`。
