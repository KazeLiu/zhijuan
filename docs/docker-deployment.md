# 用 Docker Compose 部署知卷

在一台装有 Docker Engine 和 Compose v2 的服务器上，运行一个应用容器即可使用。Windows、macOS 可用 Docker Desktop 的 **Linux 容器**模式。不需要另外安装 Node.js、pnpm、SQLite 服务或 Redis。

服务仍只面向可信内网，身份机制仍是姓名登录。不要直接把端口开放到公网。

## 在 Ubuntu 24.04 离线部署

部署服务器需预先安装 Docker Engine 和 Compose v2，能够运行 Linux 容器。离线应用包不包含 Docker 安装包或模型权重；使用 AI 出题时，仍需连接可达的内网模型服务。

以下交付约定使用 `linux/amd64` 镜像，适用于 x86_64 服务器。先运行 `uname -m`，结果应为 `x86_64`；如果是 `aarch64`，需要另行构建 ARM64 镜像，不能直接使用此包。宿主机是 Ubuntu 24.04，不要求容器基础系统也是 Ubuntu。

部署时将以下文件放在同一个目录：

```text
zhijuan-offline/
├── zhijuan-image.tar       应用镜像，包含运行时与依赖
├── compose.yaml           启动配置
├── .env.example           可选配置模板
└── docker-deployment.md   本文档
```

镜像不包含开发机的数据库、上传资料或模型凭据。首次安装会创建空数据库；如需搬迁已有数据，按下文的数据迁移步骤操作。

需要修改管理员姓名或端口时，先按本文「修改管理员与访问端口」一节创建 `.env`；使用默认值时不必创建。在上述目录执行：

```sh
docker load -i zhijuan-image.tar
docker compose up -d --no-build --pull never
docker compose ps
```

没有 Docker 操作权限时，在 Docker 命令前加 `sudo`。加载后应能看到 `compose.yaml` 中 `image` 指定的镜像标签；启动不需要访问 Docker Hub、npm 或获取源码，不要在离线服务器上执行 `--build`。

等容器状态变为 `healthy` 后，打开 `http://服务器内网IP:4310`，默认管理员姓名为 `管理员`。服务默认时区为 `Asia/Shanghai`。健康检查和日志可在服务器上查看：

```sh
curl -fsS http://127.0.0.1:4310/api/health
docker compose logs --tail=100 zhijuan
```

健康接口应返回 `data.ok: true`。若修改了端口，请同步修改访问地址。只对可信内网开放服务端口；Docker 发布端口可能绕过 UFW 规则，不要仅凭 UFW 的默认策略判断端口是否对公网关闭。

离线更新时，先按下文备份数据，再将新镜像文件复制到部署目录，执行：

```sh
docker load -i zhijuan-image.tar
docker compose up -d --no-build --pull never --force-recreate
docker compose ps
```

保留原来的 `.env` 和 `zhijuan_data` 数据卷。新包使用不同镜像标签时，同步更新 `compose.yaml` 的 `image`；其他配置变更只合并相应设置，不覆盖已有管理员配置。

## 从源码构建部署

```sh
git clone https://github.com/KazeLiu/zhijuan.git
cd zhijuan
docker compose up -d --build
```

首次构建需要访问 Docker Hub 和 npm 包仓库。之后打开 `http://服务器内网IP:4310`，默认管理员姓名为 `管理员`。在「模型设置」填写 Base URL、API Key（如需）和模型；只用题库人工维护与组卷时不需要配置模型。

查看运行状态和启动日志：

```sh
docker compose ps
docker compose logs --tail=100 zhijuan
```

容器健康检查访问 `/api/health`；启动成功后应显示 `healthy`。首次启动会自动建库并执行迁移，启动失败时先查看日志中的迁移或权限错误。

## 修改管理员与访问端口

默认配置即可启动，不要求创建 `.env`。需要修改时，在 `compose.yaml` 所在目录创建 `.env`，已有文件则只修改相关字段，不要覆盖原配置：

```dotenv
NUXT_ADMIN_NAMES='["张三","李四"]'
PORT=4310
NUXT_SESSION_TTL_DAYS=7
NUXT_SESSION_COOKIE_NAME=zj_session
```

修改后运行 `docker compose up -d`，Compose 会重建需要更新环境变量的容器，数据卷保留。单独执行 `docker compose restart` 不会重新读取新的容器环境变量。

- `PORT` 控制宿主机访问端口，容器内部固定使用 4310。
- 管理员名单必须是 JSON 字符串数组，姓名完整匹配。
- Docker 中的数据路径固定为 `/app/data` 并挂载到持久卷；主机 `.env` 中的 `NUXT_DATA_DIR` 仅用于原生 Node 部署，不会改变此挂载。
- Base URL、模型 ID 和 API Key 仍由管理页面写入数据库，不写进镜像或 Compose 文件。

## 模型地址要从容器内能访问

- 模型在另一台内网机器：使用该机器的内网地址，例如 `http://192.168.1.20:8000/v1`。
- 模型也在同一台宿主机：可使用 `http://host.docker.internal:8000/v1`，本项目已配置 `host-gateway` 映射。Linux 上宿主机的模型服务还必须监听容器可达的地址；仅监听 `127.0.0.1` 的服务不能通过默认 Docker 网桥访问。调整监听或防火墙时只开放所需的容器网络。
- 模型在另一个容器：将两个服务加入同一个 Docker 网络，使用模型的服务名和容器端口。

容器内的 `localhost` 和 `127.0.0.1` 指向知卷容器，不是宿主机。填写 API 前缀，不要填完整的 `/chat/completions` 路径。

## 数据放在哪里

默认 Compose 项目名为 `zhijuan`，数据卷名为 `zhijuan_data`，挂载到 `/app/data`：

```text
/app/data/
├── db/zhijuan.sqlite
└── uploads/
```

考试、题库、资料文件、答卷、模型配置和会话都在该卷中。镜像仅包含构建产物；容器以非 root 的 `node` 用户运行，首次创建的数据卷具有相应目录权限。

普通 `docker compose down` 和重新构建不会删除命名数据卷。**不要执行 `docker compose down -v` 或删除该卷，除非你确实要清空全部数据。** 不要用多个应用实例同时访问同一份 SQLite 数据，项目只支持单实例。

## 更新前先备份

在没有进行中出题任务、允许短暂停止服务时执行。每次使用一个新的备份目录名；下面的目录必须尚不存在：

```sh
docker compose stop zhijuan
docker compose cp zhijuan:/app/data ../zhijuan-backup-before-upgrade
docker compose start zhijuan
```

确认复制成功后再执行下方更新命令。备份目录中应直接包含 `db` 与 `uploads`，同时保留 SQLite 的 `-wal`、`-shm` 文件（如有）。备份含有模型凭据与答卷，只允许管理员读取，不要提交到 Git 或放进 Web 根目录。

源码部署更新代码并重新构建；离线部署改用本文开头的加载新镜像命令：

```sh
git pull --ff-only
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 zhijuan
```

新版本启动时自动执行追加迁移。服务重启会中断当时仍在运行的出题任务，该任务会标记失败，可在管理端重试；更新前应等待任务结束。需要回退数据库时使用升级前备份，不要只替换为旧镜像后继续写已经升级的数据。

本版包含迁移 `007-bank-keys-and-regrading`：修复题库查重键，并按当前标准重新核算已交卷答卷的自动分及总分，保留人工复核分。若日志提示题库重复条目并列出 ID，迁移会回滚并停止启动，不会自动合并或删除题目；先用升级前版本在题库中核对并处理这些重复条目，再升级。首次升级务必保留完整数据备份。

迁移 `008-bank-direct-activation` 取消题库审核，将旧的待审核题直接启用，主动停用的题目保持停用。新建、入库和编辑已启用题后均可直接组卷。

## 把原生 Node 部署的数据搬进 Docker

先完成应用镜像的构建或离线加载。停止原 Node 服务，备份原配置 `NUXT_DATA_DIR` 指向的**整个数据目录**。以下示例假设备份已放在 `../zhijuan-original-data`，其内部直接包含 `db` 与 `uploads`。

仅在目标 Docker 数据卷为空时执行：

```sh
docker compose create zhijuan
docker compose cp ../zhijuan-original-data/. zhijuan:/app/data
docker compose run --rm --no-deps --user 0 zhijuan chown -R node:node /app/data
docker compose up -d --no-build
```

`create` 只创建容器，不启动应用；复制期间不会创建新数据库。修正文件所属用户是因为 `docker cp` 向容器复制的文件默认归 root 所有，应用则以 `node` 用户运行。原生服务与容器服务不要同时写同一份数据库。搬完数据后检查模型地址，原先指向宿主机 `localhost` 的配置需要按上文调整。

### 将备份恢复到一个新数据卷

先停止当前容器，保留原卷，不在已有卷里混入备份文件。使用新的 Compose 项目名创建空卷：

```sh
docker compose stop zhijuan
docker compose -p zhijuan-restore create zhijuan
docker compose -p zhijuan-restore cp ../zhijuan-backup-before-upgrade/. zhijuan:/app/data
docker compose -p zhijuan-restore run --rm --no-deps --user 0 zhijuan chown -R node:node /app/data
docker compose -p zhijuan-restore up -d --no-build
```

前提是 `zhijuan-restore` 这个项目名此前没有使用过，并已加载或构建需要恢复使用的应用镜像。它会使用独立的 `zhijuan-restore_data` 卷，旧卷不会被覆盖。恢复后继续使用带 `-p zhijuan-restore` 的命令管理该实例；确认恢复正确前不删除原卷。

## 内网无法联网时分发镜像

以下命令供制作离线包的人执行，不需要在离线部署服务器上执行。构建机器需要能访问 Docker Hub 和 npm，并支持构建目标平台镜像。为 Ubuntu 24.04 x86_64 服务器明确指定 `linux/amd64`：

```sh
docker buildx build --platform linux/amd64 --load -t zhijuan:local .
docker save -o zhijuan-image.tar zhijuan:local
```

默认基础镜像为 `node:22-bookworm-slim`。构建环境需要使用已有的可信镜像源时，可通过 `--build-arg NODE_IMAGE=镜像源地址/library/node:22-bookworm-slim` 指定，不必修改 Docker 服务的全局设置。正式交付建议使用独立版本标签，并将交付目录中 `compose.yaml` 的 `image` 改为同一标签；交付配置可移除 `build` 字段，防止部署者误触源码构建。

将 `zhijuan-image.tar`、`compose.yaml`、`.env.example` 和本部署文档一起交付。不要把开发机真实 `.env`、`data/` 或模型凭据放进包。部署者按本文开头的离线部署步骤加载和启动即可。

离线目标机不需要源码或 pnpm。数据卷仍由 Compose 单独创建；镜像不含原有资料和模型配置，要搬数据时按前文操作。镜像中的 Linux 可执行文件必须匹配目标 CPU 架构，不能把 x86_64 镜像直接拿到 ARM64 服务器运行。

当前提供本地构建与离线导出方式，没有发布到 Docker Hub 或 GHCR。

## 已有 nginx 时反向代理

在宿主机使用 nginx 时，可将 Compose 的端口映射改为 `127.0.0.1:4310:4310`，只通过 nginx 暴露内网入口。下面的 `server_name` 需要替换为实际内网域名，HTTPS 可在 nginx 上配置：

```nginx
server {
    listen 80;
    server_name zhijuan.intranet;
    client_max_body_size 25m;

    location / {
        proxy_pass http://127.0.0.1:4310;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

必须保留浏览器访问时的 Host（含非默认端口），否则写请求会被现有同源校验拒绝。不要把 `/app/data` 或宿主机备份目录设为静态资源路径。

## 配置依据

- [Nuxt Node Server 部署](https://nuxt.com/docs/4.x/getting-started/deployment)：生产运行 `.output/server/index.mjs`。
- [Docker 持久化卷](https://docs.docker.com/engine/storage/volumes/)与 [Compose 卷定义](https://docs.docker.com/reference/compose-file/volumes/)：容器与数据独立管理。
- [Compose 网络](https://docs.docker.com/compose/how-tos/networking/)：宿主机模型地址与 `host-gateway`。
- [Docker 文件复制](https://docs.docker.com/reference/cli/docker/container/cp/)：停止状态复制、目录层级与文件所属用户。
- [Ubuntu 安装 Docker Engine](https://docs.docker.com/engine/install/ubuntu/)：Ubuntu 24.04 支持与发布端口的防火墙限制。
- [Docker 镜像加载](https://docs.docker.com/reference/cli/docker/image/load/)与 [Buildx 平台构建](https://docs.docker.com/reference/cli/docker/buildx/build/)：离线导入与目标 CPU 架构。

构建状态：2026-11-26 已生成 `dist/zhijuan-offline-0.1.0-20261126-linux-amd64.tar.gz`（78.04 MiB），镜像标签为 `zhijuan:0.1.0-20261126-b85bbfa-worktree`。使用当前工作区构建，包含至迁移 011、定向补题、滚动出题、模型连接测试，以及题库生成自动重试、失败后继续和结束问题列表；本次不增加数据库迁移。在 Ubuntu 22.04 x86_64 构建机完成 `linux/amd64` 生产构建、镜像导出及离线 Compose 配置校验，离线包已下载到本地并核对文件清单，未启动应用容器。包内含镜像、离线 Compose、可选环境模板、部署说明和构建信息；部署时在目标环境确认健康检查和内网模型的实际重试效果。
