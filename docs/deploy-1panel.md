# 1Panel 服务器部署手册（ragapi.baolinfeng.cn）

适用：服务器已装 1Panel（含 OpenResty），并已部署 booth-ai（见 booth-ai 仓库 `docs/1Panel服务端部署.md`）。  
思路：本地构建镜像并导出为 tar，上传到服务器导入后，用 `deploy/compose.yml` 启动；PostgreSQL（pgvector）与 Redis 随编排一起运行，与 booth-ai 的数据库、Redis 互不影响。

## 0. 部署全景

```
小程序 / 浏览器 ── HTTPS ── 1Panel OpenResty（host 网络）
  ├─ ragapi.baolinfeng.cn    → 127.0.0.1:3001  nyz-rag API（小程序、外部调用）
  ├─ ragadmin.baolinfeng.cn  → 127.0.0.1:5176  管理端（容器内 Nginx 把 /api/ 转给 API）
  ├─ rag.baolinfeng.cn       → 127.0.0.1:5175  用户端 Web（可选，同上）
  ├─ booth*.baolinfeng.cn    → booth-ai（已有，占用 127.0.0.1:3000、19000、19001）

Docker 网络 nyz-rag_default（网段 NYZ_SUBNET）：api · worker · web · admin · postgres（pgvector）· redis
```

`ragadmin`、`rag` 两个域名是示例，按实际修改，并与 `.env` 中的 `ADMIN_ORIGINS`、`WEB_ORIGINS` 保持一致。

### 为什么本地打包

- 服务器为 2 核、1.58 GB 内存，booth-ai 已用约 950 MB；在服务器上 `pnpm install` 与 5 个应用的 Vite 构建很可能内存不足，还会拖慢 booth-ai。
- 服务器上不需要源码和构建工具，发布与回滚只是切换镜像版本，与 booth-ai 的发布方式一致。

### 内存预算

| 容器 | 空闲时占用（本地实测） | 上限（`mem_limit`） |
| --- | --- | --- |
| api | 约 55 MB | 384 MB |
| worker | 约 45 MB | 384 MB |
| web、admin | 各约 15 MB | 各 64 MB |
| postgres | 约 80～150 MB（随缓存增长） | 384 MB |
| redis | 约 10 MB | 128 MB |

合计空闲约 250～350 MB，服务器剩余约 600 MB，余量很小。上限的作用是：某个容器失控时只有它被杀掉重启，不拖垮 booth-ai。**部署前先确认有 swap**（第 1 节）。

## 1. 前置检查

在 1Panel → 终端执行：

```bash
free -h                     # Swap 一行为 0 时，先在 1Panel 工具箱中添加 2 GB swap
uname -m                    # x86_64；aarch64 时打包加 -Platform linux/arm64
ip route                    # 记下服务器内网网段（当前主机地址为 172.21.x.x）
docker network inspect $(docker network ls -q) -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}}{{end}}'
ss -ltnp | grep -E ':(3001|5175|5176)\b'   # 应无输出，端口未被占用
```

- `NYZ_SUBNET`（默认 `10.250.250.0/24`）不能与 `ip route` 中的网段和已有 Docker 网络重叠，冲突时换一个 `/24`。
- 新域名的 A 记录指向服务器（大陆服务器需备案）。证书沿用 `*.baolinfeng.cn`。
- 安全组仍只开放 80、443；3001、5175、5176 只绑定 127.0.0.1，不要对公网开放。

## 2. 本地打包（Windows PowerShell）

```powershell
cd D:\baolf\project\nyz-rag
$v = "20261027-01"     # 版本号，每次发布换一个
./scripts/package-images.ps1 -Version $v                 # 构建 api、worker、web、admin 并导出
./scripts/package-images.ps1 -Version $v -IncludeInfra   # 首次部署：另导出 pgvector 与 Redis 镜像
```

产物在 `release/`（已被 git 与 Docker 构建忽略）：

- `nyz-rag-<版本>.tar`：四个应用镜像（约 140 MB），api 与 worker 共用层，只占一份空间；
- `nyz-rag-infra.tar`：`pgvector/pgvector:pg18`、`redis:8-alpine`。服务器能从 Docker Hub 拉取时可以不传；本地拉取失败时脚本改用本机已有的镜像并给出警告。

镜像构建自当前工作区（含未提交的修改，脚本会提示），标签中记录 git 提交号。镜像不含 `.env` 与任何密钥。

## 3. 上传与导入

1. 1Panel → 系统 → 文件，建目录 `/opt/nyz-rag/release`，上传上一步的 tar。
2. 在终端导入（也可用 1Panel → 容器 → 镜像 → 导入镜像）：

   ```bash
   docker load -i /opt/nyz-rag/release/nyz-rag-<版本>.tar
   docker load -i /opt/nyz-rag/release/nyz-rag-infra.tar     # 首次
   docker images | grep -E 'nyz-rag|pgvector|redis'
   ```

3. 确认导入后删除服务器上的 tar，节省磁盘。本地 `release/` 保留最近一两个版本用于回滚。

## 4. 配置与启动

1. 把仓库中的 `deploy/compose.yml` 上传为 `/opt/nyz-rag/compose.yml`，`deploy/.env.example` 上传为 `/opt/nyz-rag/.env`。
2. 生成密码与主密钥，填入 `.env`：

   ```bash
   echo "NYZ_POSTGRES_PASSWORD=$(openssl rand -hex 24)"
   echo "NYZ_REDIS_PASSWORD=$(openssl rand -hex 24)"
   echo "NYZ_SECRET_KEY=$(openssl rand -base64 32)"
   ```

   另外填写 `NYZ_VERSION`（与打包版本一致）、`NYZ_SUBNET`、`ADMIN_EMAIL` / `ADMIN_PASSWORD`（16 字符以上）、`ADMIN_ORIGINS`、`WEB_ORIGINS`、SMTP。`NYZ_SECRET_KEY` 与 `.env` 一起存到密码管理器。**要迁移本地数据时，`NYZ_SECRET_KEY` 必须用本地 `.env` 的值**（见第 8 节），否则在后台重新填写模型密钥与文章 token。
3. 收紧权限并启动：

   ```bash
   chmod 600 /opt/nyz-rag/.env
   cd /opt/nyz-rag
   docker compose up -d --wait
   docker compose ps          # 六个服务均为 running / healthy
   ```

   API 与 Worker 启动时自动执行数据库迁移（含创建 `vector` 扩展）。首次启动后，在管理端个人资料页修改超级管理员密码，再清空 `.env` 中的 `ADMIN_PASSWORD`。

启动后 1Panel → 容器 中可以看到 `nyz-rag-*` 容器，日志、资源占用在那里查看。日常操作统一在 `/opt/nyz-rag` 下用 `docker compose` 执行，不要在 1Panel 中单独重建这些容器（会丢失 compose 中的环境变量与网络配置）。

## 5. OpenResty 网站

### 5.1 ragapi.baolinfeng.cn

1. 网站 → 创建 → 反向代理：主域名 `ragapi.baolinfeng.cn`，代理地址 `http` + `127.0.0.1:3001`，启用 HTTPS，证书选 `*.baolinfeng.cn`。
2. 进入网站 → 反向代理，root 规则点「源文」，整段替换为：

   ```nginx
   location ^~ / {
       proxy_pass http://127.0.0.1:3001;
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

### 5.2 管理端与用户端

同样创建反向代理网站，代理到 `127.0.0.1:5176`（管理端）、`127.0.0.1:5175`（用户端），源文与 5.1 相同，只改端口。容器内的 Nginx 会把同源 `/api/` 转给 API，所以浏览器不跨域，Cookie 正常携带。

`ADMIN_ORIGINS` 必须与管理端地址栏来源完全一致（如 `https://ragadmin.baolinfeng.cn`），否则登录等写操作返回 403「不允许的管理端来源」。

## 6. 验证

```bash
curl -sS http://127.0.0.1:3001/ready; echo          # 服务器本机：{"status":"ok",...}
curl -sS https://ragapi.baolinfeng.cn/ready; echo    # 外网
curl -sS https://ragapi.baolinfeng.cn/api/knowledge; echo
curl -sS -o /dev/null -w '%{http_code}\n' https://ragadmin.baolinfeng.cn/   # 200
docker stats --no-stream                              # 看内存是否在预算内
```

验收清单：

- [ ] `docker compose ps` 中六个服务均 healthy，booth-ai 不受影响（它的健康检查仍通过）
- [ ] 管理端能登录、退出，写操作（如保存设置）不报 403
- [ ] 用户端提问时回答逐字出现（SSE 没有被缓冲）
- [ ] 连续快速请求触发限流时，返回 429 的是单个客户端，而不是所有人（可信代理生效）

## 7. 首次业务配置

在管理端依次完成（全新数据库时）：

1. 模型配置：添加模型供应商（地址、API Key），在业务模型中为 Chat、Embedding、Rerank（可选）、改写（可选）选择供应商与模型。
2. 数据源页：保存 nyzdata 文章 token，添加文章 API 来源，执行同步；同步后 Worker 自动向量化。
3. 知识库：创建知识库（检索参数、是否 Rerank、引用校验）。
4. 用户端提问验证。

全量同步与向量化会调用 Embedding 产生费用；2 核服务器上耗时较长，期间注意内存（`docker stats`）。

## 8.（可选）迁移本地数据

用本地已同步、已向量化的数据，免去重新同步与向量化。**必须在第 4 步首次启动 api / worker 之前做**，且服务器 `.env` 的 `NYZ_SECRET_KEY` 与本地相同。

本地导出（不含评估实验 schema）：

```powershell
pg_dump -Fc --exclude-schema='eval_*' -d "postgresql://nyzrag:<密码>@localhost:5432/nyzrag" -f release/nyzrag.dump
```

`pg_dump` 的主版本须不低于数据库（18）。本机没有时，可以在共享 PostgreSQL 容器内执行后用 `docker cp` 拷出（不要用 PowerShell 的 `>` 重定向，会损坏二进制文件）。

上传到 `/opt/nyz-rag/release/` 后，在服务器只启动数据库并恢复：

```bash
cd /opt/nyz-rag
docker compose up -d --wait postgres
docker compose cp release/nyzrag.dump postgres:/tmp/nyzrag.dump
docker compose exec postgres pg_restore -U nyzrag -d nyzrag --no-owner --no-privileges --exit-on-error /tmp/nyzrag.dump
docker compose exec postgres rm /tmp/nyzrag.dump
rm release/nyzrag.dump
docker compose up -d --wait
```

迁移记录随数据一起恢复，API 启动时只补跑缺少的迁移。本地 `release/nyzrag.dump` 含业务数据与加密的密钥，用完即删。

## 9. 日常运维

### 9.1 发布新版本

1. 本地执行第 2 步（新版本号，不需要 `-IncludeInfra`），按第 3 步上传、导入。
2. 先备份数据库（9.2 的任务手动执行一次）。
3. 修改 `/opt/nyz-rag/.env` 的 `NYZ_VERSION`，执行 `docker compose up -d --wait`。Worker 最多等 60 秒让执行中的操作收尾，未完成的操作由租约机制重新执行。
4. 确认 `curl -sS http://127.0.0.1:3001/ready` 正常后，用 `docker image rm` 清理旧版本，保留上一个版本用于回滚。

回滚：把 `NYZ_VERSION` 改回旧版本后 `docker compose up -d --wait`。**只有新版本没有新增迁移，或新增迁移与旧代码兼容时才能直接回滚**，否则先恢复数据库备份。

### 9.2 备份

1Panel → 计划任务 → 创建「Shell 脚本」任务（建议每天凌晨），内容：

```bash
set -e
mkdir -p /opt/nyz-rag/backup
cd /opt/nyz-rag
docker compose exec -T postgres pg_dump -U nyzrag -d nyzrag -Fc --exclude-schema='eval_*' > backup/nyzrag-$(date +%F).dump
find backup -name 'nyzrag-*.dump' -mtime +14 -delete
```

再建一个「备份目录」任务备份 `/opt/nyz-rag/backup`，上传到云存储账号；只存在本机的不算备份。`/opt/nyz-rag/.env`（含 `NYZ_SECRET_KEY`）另行保存到密码管理器：丢失主密钥后，已保存的模型密钥与 token 无法解密，只能重新填写。恢复演练见 [backup-restore.md](backup-restore.md)。Redis 不备份。

### 9.3 诊断

- 日志：`docker compose logs -f api`（或 `worker`），也可在 1Panel → 容器 中查看。
- 后台操作积压：管理端数据源页；排队超过 5 分钟时检查 Worker。
- 数据库：`docker compose exec postgres psql -U nyzrag -d nyzrag`。

## 10. 常见问题

| 现象 | 排查方向 |
| --- | --- |
| `docker compose up` 报 `set NYZ_... in .env` | `.env` 中对应变量为空 |
| 报 `Pool overlaps with other one on this address space` | `NYZ_SUBNET` 与已有 Docker 网络重叠，换一个网段 |
| `pull access denied for nyz-rag-api` | 镜像没导入，或 `NYZ_VERSION` 与导入的版本不一致 |
| 拉取 `pgvector/pgvector`、`redis` 超时 | 用 `-IncludeInfra` 打包后导入，或在 1Panel 容器设置中配置镜像加速 |
| 容器反复重启，`docker inspect` 显示 `OOMKilled: true` | 内存上限不够：先确认 swap，再适当提高该服务的 `mem_limit` |
| 502 | `curl 127.0.0.1:3001/health`；OpenResty 是否 host 网络 |
| 管理端登录或写操作 403「不允许的管理端来源」 | `ADMIN_ORIGINS` 与地址栏来源不一致 |
| 回答一次性出现，没有逐字输出 | 网站代理没有 `proxy_buffering off`，或开启了网站缓存 / CDN |
| 所有人共用一个限流额度（429） | `TRUSTED_PROXIES`（即 `NYZ_SUBNET`）不包含请求进入容器时的来源地址 |
| 注册、找回密码返回 503 | 未配置 SMTP |
| 已保存的模型密钥报无法解密 | `NYZ_SECRET_KEY` 与保存时不同，在后台重新填写 |
