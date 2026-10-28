# 1Panel 服务器部署手册（ragapi.baolinfeng.cn）

适用：服务器已装 1Panel（含 OpenResty），并已部署 booth-ai（见 booth-ai 仓库 `docs/1Panel服务端部署.md`）。  
思路：本地构建镜像并导出为 tar，上传到服务器导入后，用 `deploy/compose.yml` 启动 api、worker、web、admin。PostgreSQL 与 Redis 用 1Panel 应用商店中的实例，与 booth-ai 及以后的项目共用：每个项目在 PostgreSQL 中有自己的库与账号，在 Redis 中有自己的逻辑库编号，服务器上不再为每个项目各跑一套。

## 0. 部署全景

```
小程序 / 浏览器 ── HTTPS ── 1Panel OpenResty（host 网络）
  ├─ ragapi.baolinfeng.cn    → 127.0.0.1:3010  nyz-rag API（小程序、外部调用）
  ├─ ragadmin.baolinfeng.cn  → 127.0.0.1:5011  管理端（容器内 Nginx 把 /api/ 转给 API）
  ├─ rag.baolinfeng.cn       → 127.0.0.1:5010  用户端 Web（可选，同上）
  ├─ booth*.baolinfeng.cn    → booth-ai（已有，占用 127.0.0.1:3000、19000、19001）

Docker 网络 nyz-rag_default（网段 NYZ_SUBNET）：api · worker · web · admin
Docker 网络 1panel-network（1Panel 创建，网段 NYZ_SHARED_SUBNET）：api · worker · booth-ai · 1Panel-postgresql-* · 1Panel-redis-*
```

`ragadmin`、`rag` 两个域名是示例，按实际修改，并与 `.env` 中的 `ADMIN_ORIGINS`、`WEB_ORIGINS` 保持一致。

共用实例（1Panel 应用商店安装）：

| 应用 | 本服务器容器名 | 镜像 | 本项目使用 |
| --- | --- | --- | --- |
| PostgreSQL 18 | `1Panel-postgresql-XXXX`（第 4.1 节重装后会变） | `pgvector/pgvector:pg18`（第 4.1 节重装） | 库 `nyzrag`，账号 `nyzrag`（非超级用户） |
| Redis 7.4 | `1Panel-redis-xCYH` | `redis:7.4.10` | 逻辑库 `1`；键另带 `DOCUMENT_QUEUE_NAME` 前缀 |

本地开发的共用基础设施 `D:/baolf/infra` 与这里约定相同，各项目的库、账号与 Redis 编号见其 `README.md`：agent-template `app` / 0，nyz-rag `nyzrag` / 1，booth-ai `booth` / 2（测试 15）。以后的项目照此办理：PostgreSQL 新建自己的库与账号（第 4.2 节），Redis 选一个未用的逻辑库编号，容器加入 `1panel-network`。重装 1Panel 应用后容器名的后缀会变，以 `docker ps` 为准。

### 为什么本地打包

- 服务器为 2 核、1.58 GB 内存，booth-ai 已用约 950 MB；在服务器上 `pnpm install` 与 5 个应用的 Vite 构建很可能内存不足，还会拖慢 booth-ai。
- 服务器上不需要源码和构建工具，发布与回滚只是切换镜像版本，与 booth-ai 的发布方式一致。

### 内存预算

| 容器 | 空闲时占用（本地实测） | 上限（`mem_limit`） |
| --- | --- | --- |
| api | 约 55 MB | 384 MB |
| worker | 约 45 MB | 384 MB |
| web、admin | 各约 15 MB | 各 64 MB |

合计空闲约 130 MB；数据库与 Redis 用共用实例，nyz-rag 的数据只使共用 PostgreSQL 的缓存与 Redis 略有增长。服务器余量仍然很小，上限的作用是：某个容器失控时只有它被杀掉重启，不拖垮 booth-ai。**部署前先确认有 swap**（第 1 节）。

## 1. 前置检查

在 1Panel → 终端执行：

```bash
free -h                     # Swap 一行为 0 时，先在 1Panel 工具箱中添加 2 GB swap
uname -m                    # x86_64；aarch64 时打包加 -Platform linux/arm64
ip route                    # 记下服务器内网网段（当前主机地址为 172.21.x.x）
docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'   # 1panel-network 的网段填入 NYZ_SHARED_SUBNET
ss -ltnp | grep -E ':(3010|5010|5011)\b'   # 应无输出，端口未被占用
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Networks}}' | grep -E 'postgresql|redis'   # 共用实例的容器名
docker exec 1Panel-redis-xCYH redis-cli -a '<Redis 密码>' --no-auth-warning CONFIG GET maxmemory-policy   # 须为 noeviction
docker exec 1Panel-redis-xCYH redis-cli -a '<Redis 密码>' --no-auth-warning INFO keyspace   # 确认 db1 未被使用
```

- `NYZ_SUBNET`（默认 `10.250.250.0/24`）不能与 `ip route` 中的网段和已有 Docker 网络重叠，冲突时换一个 `/24`。
- Redis 密码在 1Panel → 数据库 → Redis 的连接信息中查看。`maxmemory-policy` 必须是 `noeviction`（BullMQ 的要求，否则内存满时队列任务会被静默淘汰）；不是时在 1Panel → 数据库 → Redis → 配置中修改。这会让 booth-ai 在 Redis 写满时收到错误而不是淘汰旧键，所以同时确认 `maxmemory` 为 0（不限）或足够大。
- 新域名的 A 记录指向服务器（大陆服务器需备案）。证书沿用 `*.baolinfeng.cn`。
- 安全组仍只开放 80、443；3010、5010、5011 只绑定 127.0.0.1，不要对公网开放。

## 2. 本地打包（Windows PowerShell）

```powershell
cd D:\baolf\project\nyz-rag
$v = "20261027-01"     # 版本号，每次发布换一个
./scripts/package-images.ps1 -Version $v              # 构建 api、worker、web、admin 并导出
./scripts/package-images.ps1 -Version $v -IncludePgvector   # 首次部署且服务器拉不到 Docker Hub：另导出 pgvector/pgvector:pg18
```

产物在 `release/`（已被 git 与 Docker 构建忽略）：

- `nyz-rag-<版本>.tar`：四个应用镜像（约 140 MB），api 与 worker 共用层，只占一份空间；
- `pgvector-pg18.tar`（`-IncludePgvector`）：`pgvector/pgvector:pg18`，与本地共用基础设施相同的镜像，供第 4.1 节重装 1Panel PostgreSQL 使用；本地拉取失败时脚本改用本机已有的镜像并给出警告。

镜像构建自当前工作区（含未提交的修改，脚本会提示），标签中记录 git 提交号。镜像不含 `.env` 与任何密钥。

## 3. 上传与导入

1. 1Panel → 系统 → 文件，建目录 `/opt/nyz-rag/release`，上传上一步的 tar。
2. 在终端导入（也可用 1Panel → 容器 → 镜像 → 导入镜像）：

   ```bash
   docker load -i /opt/nyz-rag/release/nyz-rag-<版本>.tar
   docker load -i /opt/nyz-rag/release/pgvector-pg18.tar   # 首次（-IncludePgvector）
   docker images | grep -E 'nyz-rag|pgvector'
   ```

3. 确认导入后删除服务器上的 tar，节省磁盘。本地 `release/` 保留最近一两个版本用于回滚。

## 4. 共用的 PostgreSQL 与 Redis

### 4.1 PostgreSQL 重装为 pgvector 镜像（各项目共用，只做一次）

与本地共用基础设施（`D:/baolf/infra`）使用同一个镜像 `pgvector/pgvector:pg18`。1Panel 原装的是官方 `postgres:18.6-alpine`（没有 pgvector），alpine（musl）与 Debian（glibc）的排序规则不同，不能只换镜像沿用数据目录，所以卸载后重装。

**会清空 1Panel PostgreSQL 中的全部数据**。目前只有 booth-ai 的测试数据，已确认不保留；先在 1Panel 编排中停止 booth-ai。

1. 服务器拉不到 Docker Hub 时，先导入第 2、3 步打包的 `pgvector-pg18.tar`。
2. 1Panel → 应用商店 → 已安装 → postgresql → 卸载（删除数据）。
3. 应用商店 → PostgreSQL → 安装：版本 18.x，不勾选「端口外部访问」；展开高级设置，勾选「编辑 compose 文件」，只把 `image:` 改为 `pgvector/pgvector:pg18`（以实际界面为准）。超级用户名与密码记下，只用于建库建账号。
4. 确认（重装后容器名后缀会变，以 `docker ps` 为准，并同步本手册与各项目配置中的容器名）：

   ```bash
   PG=$(docker ps --format '{{.Names}}' | grep '^1Panel-postgresql-')
   docker inspect $PG -f '{{.Config.Image}}'     # pgvector/pgvector:pg18
   docker exec $PG ls /usr/share/postgresql/18/extension/vector.control
   ```

5. booth-ai 按它的部署手册（booth-ai 仓库 `docs/1Panel服务端部署.md` 第 2.1 节）重新建 `booth` 库与账号，更新其编排中的 PostgreSQL 容器名后启动，再重新录入数据。

**不要在 1Panel「可升级」中升级 PostgreSQL**：升级会把镜像换回官方镜像，所有用到 pgvector 的项目随即报错（`could not access file "$libdir/vector"`）。需要更新时，在应用参数中编辑 compose 文件，保持 `pgvector/pgvector:pg18` 后重建。

### 4.2 建库与账号

nyz-rag 用专用库 `nyzrag` 与非超级用户账号 `nyzrag`。pgvector 不是受信任扩展，`vector` 由超级用户在库中预先创建（迁移中的 `CREATE EXTENSION IF NOT EXISTS` 随之跳过）。以后的项目照此新建自己的库与账号。

```bash
PG=$(docker ps --format '{{.Names}}' | grep '^1Panel-postgresql-')
PG_ADMIN=$(docker exec $PG printenv POSTGRES_USER)    # 1Panel 安装时的超级用户
NYZ_DB_PASSWORD=$(openssl rand -hex 24); echo "$NYZ_DB_PASSWORD"   # 记下，填入 .env 的 DATABASE_URL
docker exec -i $PG psql -U "$PG_ADMIN" -d postgres -v ON_ERROR_STOP=1 -v pw="$NYZ_DB_PASSWORD" <<'SQL'
CREATE ROLE nyzrag LOGIN PASSWORD :'pw';
CREATE DATABASE nyzrag OWNER nyzrag;
-- 其他项目的账号不能连接本库
REVOKE ALL ON DATABASE nyzrag FROM PUBLIC;
\c nyzrag
CREATE EXTENSION vector;
SQL
```

也可以在 1Panel → 数据库 → PostgreSQL 中创建库与账号（不要设为超级用户），之后同样要用超级用户在库中执行 `CREATE EXTENSION vector`。

API 与 Worker 各有一个连接池（最多 10 个连接），共用实例的 `max_connections`（默认 100）要容纳所有项目的连接池。

### 4.3 Redis

不需要创建什么：本项目用逻辑库 `1`（`REDIS_URL` 末尾的 `/1`），键另带 `DOCUMENT_QUEUE_NAME` 前缀。确认第 1 节的 `maxmemory-policy` 与 db1 未被占用即可。以后的项目各用一个未用的编号。**不要在共用 Redis 上执行 `FLUSHALL`。**

## 5. 配置与启动

1. 把仓库中的 `deploy/compose.yml` 上传为 `/opt/nyz-rag/compose.yml`，`deploy/.env.example` 上传为 `/opt/nyz-rag/.env`。
2. 填写 `.env`：

   - `DATABASE_URL=postgresql://nyzrag:<4.2 的密码>@1Panel-postgresql-XXXX:5432/nyzrag`
   - `REDIS_URL=redis://:<Redis 密码>@1Panel-redis-xCYH:6379/1`（密码含字母数字以外的字符时须 URL 编码）
   - `NYZ_SHARED_SUBNET`：第 1 节查到的 `1panel-network` 网段
   - `NYZ_SECRET_KEY`：`openssl rand -base64 32` 生成，与 `.env` 一起存到密码管理器。**要迁移本地数据时，必须用本地 `.env` 的值**（见第 9 节），否则在后台重新填写模型密钥与文章 token。
   - `NYZ_VERSION`（与打包版本一致）、`NYZ_SUBNET`、`ADMIN_EMAIL` / `ADMIN_PASSWORD`（16 字符以上）、`ADMIN_ORIGINS`、`WEB_ORIGINS`、SMTP。

3. 收紧权限并启动：

   ```bash
   chmod 600 /opt/nyz-rag/.env
   cd /opt/nyz-rag
   docker compose up -d --wait
   docker compose ps          # 四个服务均为 running / healthy
   ```

   API 与 Worker 启动时自动执行数据库迁移。首次启动后，在管理端个人资料页修改超级管理员密码，再清空 `.env` 中的 `ADMIN_PASSWORD`。

启动后 1Panel → 容器 中可以看到 `nyz-rag-*` 容器，日志、资源占用在那里查看。日常操作统一在 `/opt/nyz-rag` 下用 `docker compose` 执行，不要在 1Panel 中单独重建这些容器（会丢失 compose 中的环境变量与网络配置）。

## 6. OpenResty 网站

### 6.1 ragapi.baolinfeng.cn

1. 网站 → 创建 → 反向代理：主域名 `ragapi.baolinfeng.cn`，代理地址 `http` + `127.0.0.1:3010`，启用 HTTPS，证书选 `*.baolinfeng.cn`。
2. 进入网站 → 反向代理，root 规则点「源文」，整段替换为：

   ```nginx
   location ^~ / {
       proxy_pass http://127.0.0.1:3010;
       proxy_http_version 1.1;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       # 覆盖而不是追加：不信任客户端自带的 X-Forwarded-For
       proxy_set_header X-Forwarded-For $remote_addr;
       proxy_set_header X-Forwarded-Proto $scheme;
       proxy_set_header Connection "";
       # 流式问答（SSE）与管理端概览推送需要关闭缓冲
       proxy_buffering off;
       proxy_cache off;
       proxy_read_timeout 3600s;
       proxy_send_timeout 3600s;
   }
   ```

3. 勾选 HTTP 自动跳转 HTTPS。

### 6.2 管理端与用户端

同样创建反向代理网站，代理到 `127.0.0.1:5011`（管理端）、`127.0.0.1:5010`（用户端），源文与 6.1 相同，只改端口。容器内的 Nginx 会把同源 `/api/` 转给 API，所以浏览器不跨域，Cookie 正常携带。

`ADMIN_ORIGINS` 必须与管理端地址栏来源完全一致（如 `https://ragadmin.baolinfeng.cn`），否则登录等写操作返回 403「不允许的管理端来源」。

## 7. 验证

```bash
curl -sS http://127.0.0.1:3010/ready; echo          # 服务器本机：{"status":"ok",...}
curl -sS https://ragapi.baolinfeng.cn/ready; echo    # 外网
curl -sS https://ragapi.baolinfeng.cn/api/knowledge; echo
curl -sS -o /dev/null -w '%{http_code}\n' https://ragadmin.baolinfeng.cn/   # 200
docker stats --no-stream                              # 看内存是否在预算内
```

验收清单：

- [ ] `docker compose ps` 中四个服务均 healthy，booth-ai 不受影响（它的健康检查仍通过）
- [ ] 管理端能登录、退出，写操作（如保存设置）不报 403
- [ ] 用户端提问时回答逐字出现（SSE 没有被缓冲）
- [ ] 连续快速请求触发限流时，返回 429 的是单个客户端，而不是所有人（可信代理生效）

## 8. 首次业务配置

在管理端依次完成（全新数据库时）：

1. 模型配置：添加模型供应商（地址、API Key），在业务模型中为 Chat、Embedding、Rerank（可选）、改写（可选）选择供应商与模型。
2. 数据源页：保存 nyzdata 文章 token，添加文章 API 来源，执行同步；同步后 Worker 自动向量化。
3. 知识库：创建知识库（检索参数、是否 Rerank、引用校验）。
4. 用户端提问验证。

全量同步与向量化会调用 Embedding 产生费用；2 核服务器上耗时较长，期间注意内存（`docker stats`）。

## 9.（可选）迁移本地数据

用本地已同步、已向量化的数据，免去重新同步与向量化。**必须在第 4.2 节建库之后、第 5 步首次启动 api / worker 之前做**，且服务器 `.env` 的 `NYZ_SECRET_KEY` 与本地相同。

本地导出（不含评估实验 schema）：

```powershell
pg_dump -Fc --exclude-schema='eval_*' -d "postgresql://nyzrag:<密码>@localhost:5432/nyzrag" -f release/nyzrag.dump
```

`pg_dump` 的主版本须不低于数据库（18）。本机没有时，可以在共享 PostgreSQL 容器内执行后用 `docker cp` 拷出（不要用 PowerShell 的 `>` 重定向，会损坏二进制文件）。

上传到 `/opt/nyz-rag/release/` 后恢复到共用实例。以账号 `nyzrag` 恢复（对象归它所有），并跳过备份中的 `vector` 扩展条目（第 4.2 节已由超级用户创建，`nyzrag` 无权再建或给它加注释）：

```bash
PG=$(docker ps --format '{{.Names}}' | grep '^1Panel-postgresql-')
cd /opt/nyz-rag
docker cp release/nyzrag.dump $PG:/tmp/nyzrag.dump
docker exec $PG sh -c "pg_restore -l /tmp/nyzrag.dump | grep -v ' EXTENSION ' > /tmp/nyzrag.list"
docker exec $PG pg_restore -U nyzrag -d nyzrag --no-owner --no-privileges --exit-on-error -L /tmp/nyzrag.list /tmp/nyzrag.dump
docker exec $PG rm /tmp/nyzrag.dump /tmp/nyzrag.list
rm release/nyzrag.dump
```

迁移记录随数据一起恢复，API 启动时只补跑缺少的迁移。本地 `release/nyzrag.dump` 含业务数据与加密的密钥，用完即删。

## 10. 日常运维

### 10.1 发布新版本

1. 本地执行第 2 步（新版本号，不需要 `-IncludePgvector`），按第 3 步上传、导入。
2. 先备份数据库（10.2 的任务手动执行一次）。
3. 修改 `/opt/nyz-rag/.env` 的 `NYZ_VERSION`，执行 `docker compose up -d --wait`。Worker 最多等 60 秒让执行中的操作收尾，未完成的操作由租约机制重新执行。
4. 确认 `curl -sS http://127.0.0.1:3010/ready` 正常后，用 `docker image rm` 清理旧版本，保留上一个版本用于回滚。

回滚：把 `NYZ_VERSION` 改回旧版本后 `docker compose up -d --wait`。**只有新版本没有新增迁移，或新增迁移与旧代码兼容时才能直接回滚**，否则先恢复数据库备份。

### 10.2 备份

1Panel → 计划任务 → 创建「Shell 脚本」任务（建议每天凌晨），内容：

```bash
set -e
mkdir -p /opt/nyz-rag/backup
cd /opt/nyz-rag
docker exec 1Panel-postgresql-XXXX pg_dump -U nyzrag -d nyzrag -Fc --exclude-schema='eval_*' > backup/nyzrag-$(date +%F).dump
find backup -name 'nyzrag-*.dump' -mtime +14 -delete
```

再建一个「备份目录」任务备份 `/opt/nyz-rag/backup`，上传到云存储账号；只存在本机的不算备份。`/opt/nyz-rag/.env`（含 `NYZ_SECRET_KEY`）另行保存到密码管理器：丢失主密钥后，已保存的模型密钥与 token 无法解密，只能重新填写。恢复演练见 [backup-restore.md](backup-restore.md)。Redis 不备份。1Panel 自带的数据库备份可以另外开启（覆盖 booth-ai 等其他库），本项目的恢复与演练以上面的 `-Fc` 备份为准。

### 10.3 诊断

- 日志：`docker compose logs -f api`（或 `worker`），也可在 1Panel → 容器 中查看。
- 后台操作积压：管理端数据源页；排队超过 5 分钟时检查 Worker。
- 数据库：`docker exec -it 1Panel-postgresql-XXXX psql -U nyzrag -d nyzrag`。

## 11. 常见问题

| 现象 | 排查方向 |
| --- | --- |
| `docker compose up` 报 `set ... in .env` | `.env` 中对应变量为空 |
| 报 `Pool overlaps with other one on this address space` | `NYZ_SUBNET` 与已有 Docker 网络重叠，换一个网段 |
| 报 `network 1panel-network declared as external, but could not be found` | `NYZ_SHARED_NETWORK` 与 `docker network ls` 中 1Panel 的网络名不一致 |
| `pull access denied for nyz-rag-api` | 镜像没导入，或 `NYZ_VERSION` 与导入的版本不一致 |
| API 不健康，日志 `getaddrinfo ENOTFOUND 1Panel-postgresql-…` | `DATABASE_URL` / `REDIS_URL` 中的容器名与 `docker ps` 不一致（重装 1Panel 应用后后缀会变） |
| 迁移或查询报 `type "vector" does not exist`、`$libdir/vector` | PostgreSQL 镜像被换回了官方镜像（1Panel 升级或重装应用），按第 4.1 节改回；或没有在 `nyzrag` 库中创建扩展 |
| Worker 日志 `Eviction policy is … It should be "noeviction"` | 共用 Redis 的 `maxmemory-policy`，见第 1 节 |
| 安装 PostgreSQL 时拉取 `pgvector/pgvector:pg18` 超时 | 本地用 `-IncludePgvector` 打包后导入，或在 1Panel 容器设置中配置镜像加速 |
| 容器反复重启，`docker inspect` 显示 `OOMKilled: true` | 内存上限不够：先确认 swap，再适当提高该服务的 `mem_limit` |
| 502 | `curl 127.0.0.1:3010/health`；OpenResty 是否 host 网络 |
| 管理端登录或写操作 403「不允许的管理端来源」 | `ADMIN_ORIGINS` 与地址栏来源不一致 |
| 回答一次性出现，没有逐字输出 | 网站代理没有 `proxy_buffering off`，或开启了网站缓存 / CDN |
| 所有人共用一个限流额度（429） | `TRUSTED_PROXIES`（`NYZ_SUBNET` 与 `NYZ_SHARED_SUBNET`）不包含请求进入容器时的来源地址 |
| 注册、找回密码返回 503 | 未配置 SMTP |
| 已保存的模型密钥报无法解密 | `NYZ_SECRET_KEY` 与保存时不同，在后台重新填写 |
