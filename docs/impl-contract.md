# 知卷 · 实现契约（v1.0 · 冻结基线）

> 读者：并行开发的两名实现者（**后端专家**、**前端专家**）。
> 业务规则唯一依据：`docs/design.md` v0.3。工程约定唯一依据：本文件。
> 两者冲突时：业务规则以 design.md 为准；工程细节（目录、字段名、路由、DTO、错误码、文件归属）以本文件为准，并按 §1 登记变更。
> 契约状态：**已冻结**。骨架已真实跑通（证据见 §2.3）。

---

## 1. 变更纪律（先读这条）

1. 本文件冻结。任何字段/路径/错误码的增删改都属于**契约变更**：先在 §15 变更记录追加一行（日期 / 提出方 / 变更点 / 影响面），再改 `shared/types/**`，然后通知另一位实现者。没有登记就改类型 = 打断对方编译。
2. 只允许**追加**：新增接口、新增 DTO、新增常量、新增可选字段（且带默认值语义）。**不得改名、不得改语义、不得改默认值**。
3. 以下文件为**冻结文件**，两位实现者都不得修改：
   - `nuxt.config.ts`、`package.json`、`pnpm-lock.yaml`、`tsconfig.json`、`.gitignore`、`.env.example`
   - `docs/design.md`（只读业务依据）
   - `server/db/migrations/001-init.ts`（已应用，不得改 SQL；要改结构就追加 `002-*.ts`）
   - `app/assets/styles/main.css` 中已声明的 CSS 变量名与值（可追加新变量）
4. **不得新增依赖**：Excel 导出、PDF/DOCX/TXT/MD 解析、日期处理、校验、图标、日期选择器所需的库都已装齐（§2.2）。确有缺口先回报，不要 `pnpm add`。
5. **不得写占位业务数据 / 假接口**。接口未实现时前端只用 loading / empty / error 三态，不内置假数据、不 localStorage 假持久化。后端不得返回硬编码题目或假汇总。
6. 禁止客户端直连 SQLite 或模型服务；禁止把 `server/**` 的模块 import 进 `app/**`；`shared/**` 里不得出现 `node:*`、`fs`、`process` 等仅服务端可用的引用。
7. 一律使用 `node:sqlite` 的**位置参数 `?`** 绑定（`stmt.run(a, b)` / `stmt.get(a)` / `stmt.all(a)`），不要用命名参数，避免驱动版本差异。

---

## 2. 基线（已实测，不是计划）

### 2.1 运行时

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows（目标机同款），内网单机 |
| Node.js | v22.19.0（`node:sqlite` 可用，启动会打印 `ExperimentalWarning: SQLite is an experimental feature`，属预期噪声） |
| pnpm | 9.12.1 |
| 应用形态 | 单个 Nuxt 4 全栈进程（Nitro），无第二个后端、无外部中间件必需项 |
| 数据存储 | SQLite 文件 + 本地上传目录，均在 `data/`（不进 Git） |

### 2.2 依赖清单（已写入 `package.json` 并锁定 `pnpm-lock.yaml`，一次装齐）

dependencies：

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `nuxt` | 4.5.1 | 全栈框架（Nitro 2.13.5 / Vite 8.3.5） |
| `vue` | 3.5.44 | 视图层 |
| `element-plus` | 2.14.7 | UI 组件库（指定不可替换） |
| `@element-plus/nuxt` | 1.1.5 | 组件/样式按需自动引入 |
| `@element-plus/icons-vue` | 2.3.2 | 图标 |
| `zod` | 4.6.7 | 请求体 / AI 输出校验 |
| `exceljs` | 4.4.0 | 场次汇总导出 `.xlsx` |
| `unpdf` | 1.9.1 | 文字版 PDF 逐页文本抽取（无 OCR） |
| `mammoth` | 1.13.0 | DOCX 正文抽取 |
| `dayjs` | 1.11.23 | 日期计算与格式化（时区展示优先用 `Intl.DateTimeFormat`） |

devDependencies：`typescript` 5.9.3、`vue-tsc` 3.3.13、`@types/node` 22.20.5。

> `node:sqlite` 是 Node 内置模块，**不需要也不允许**安装 `better-sqlite3` 等原生依赖（原因见 `docs/adr/ADR-001-sqlite-driver.md`）。

### 2.3 脚本与真实运行证据

| 命令 | 行为 |
| --- | --- |
| `pnpm install` | 安装依赖并触发 `nuxt prepare` 生成 `.nuxt`（含 `#shared` 别名与 TS 工程引用） |
| `pnpm dev` | 开发服务器，固定端口 **4310**（`nuxt dev --port 4310`） |
| `pnpm build` | 生产构建，产物目录 `.output/` |
| `pnpm start` | `node .output/server/index.mjs`，端口读 `PORT`（默认 4310） |
| `pnpm preview` | 预览生产构建 |
| `pnpm typecheck` | `nuxt typecheck`（vue-tsc），提交前自检用 |

已实测（2026-10-23，本机）：

- `pnpm install` → `exit code 0`，`+760` 包，`Done in 2m 21.2s`。
- `pnpm dev` → `Local: http://localhost:4310/`，Nitro 构建成功。
- 启动即执行迁移：日志 `[db] 数据目录 D:\code\zhijuan\data，schema 版本 1`。
- `GET http://localhost:4310/api/health` → `200`，`{"data":{"ok":true,"serverNow":1792730681106,"schemaVersion":1}}`。
- `GET http://localhost:4310/` → `200`，`text/html`，`<title>知卷</title>`，占位页含「项目骨架已就绪」。

已知噪声（不影响功能，不要为此改架构）：

- `WARN "node:sqlite" is imported by "server/utils/db.ts", but could not be resolved – treating it as an external dependency.`（Vite SSR 对内置模块的提示）
- `WARN [NUXT_B7002] ... vite.optimizeDeps.include entries could not be resolved: lodash-unified`（`@element-plus/nuxt` 模块自带，升级模块前忽略）
- 本机 `127.0.0.1:4310` 被另一个本地进程占用，Nuxt 实际监听 `[::1]:4310`；**开发访问一律用 `http://localhost:4310`**，不要用 `127.0.0.1`。

---

## 3. 目录结构与文件归属

```
D:\code\zhijuan\
├─ app/                         前端（仅前端专家可改）
│  ├─ app.vue                   ✅ Element Plus 全局配置 + Layout/Page 挂载
│  ├─ assets/styles/main.css    ✅ 设计令牌（§4.5），只允许追加变量
│  ├─ layouts/
│  │  ├─ default.vue            ✅ 考生端布局（顶栏 + 内容区）
│  │  └─ admin.vue              ⬜ 待建：管理端侧栏布局
│  ├─ pages/
│  │  ├─ index.vue              ✅ 占位（须替换为登录/入口页）
│  │  ├─ exams/[examId]/attempt.vue          ⬜ 逐题作答页
│  │  ├─ attempts/[attemptId]/result.vue     ⬜ 结果页
│  │  ├─ me/attempts.vue                     ⬜ 我的记录
│  │  └─ admin/…                             ⬜ 见 §9.2
│  ├─ components/               ⬜ 前端组件（admin/ 与 candidate/ 两个子目录）
│  ├─ composables/              ⬜ useApi / useAttemptDraft / useCountdown 等
│  └─ utils/                    ⬜ 前端纯函数（分值格式化、时间格式化、答案比较）
├─ server/                      后端（仅后端专家可改）
│  ├─ api/                      ✅ health.get.ts；其余按 §8 逐个新建
│  ├─ middleware/               ⬜ 后端可加（如全局 no-store 兜底）
│  ├─ plugins/
│  │  └─ database.ts            ✅ 启动初始化 DB + 迁移
│  ├─ db/
│  │  ├─ migrations/001-init.ts ✅ 首版 DDL（冻结）
│  │  ├─ migrations/index.ts    ✅ 迁移清单（只追加）
│  │  ├─ types.ts               ✅ Migration 接口
│  │  └─ queries/               ⬜ 各域 SQL 与行映射（exam/attempt/question/…）
│  ├─ services/                 ⬜ session / auth / exam / attempt / grading / job / document / export
│  ├─ ai/                       ⬜ client（OpenAI 兼容）、prompt、parser、validator
│  ├─ tasks/                    ⬜ 截止检查（每秒）与出题任务调度（每秒）
│  └─ utils/
│     ├─ paths.ts               ✅ 数据目录解析与创建
│     ├─ db.ts                  ✅ 单连接、事务包装、迁移执行
│     └─ respond.ts             ✅ 统一响应外壳与业务异常
├─ shared/                      契约层（双方均可追加，见 §1）
│  ├─ constants.ts              ✅ 冻结常量
│  └─ types/
│     ├─ common.ts              ✅ ApiSuccess / ApiErrorBody / ApiErrorCode / API_ERROR_STATUS / Paginated
│     ├─ auth.ts                ✅ 登录与会话 DTO
│     ├─ exam.ts                ✅ 场次、资料、任务 DTO + BlueprintDTO
│     ├─ question.ts            ✅ 题目、作答、结果题目 DTO
│     ├─ attempt.ts             ✅ 答卷、交卷、结果 DTO
│     ├─ admin.ts               ✅ 设置、概览、汇总、改分、预览 DTO
│     └─ index.ts               ✅ 统一导出
├─ data/                        运行时私有数据（.gitignore；不得提交、不得对外静态暴露）
├─ docs/
│  ├─ design.md                 ✅ v0.3 业务依据（只读）
│  ├─ impl-contract.md          ← 本文件
│  ├─ DEEPSEEK_HANDOFF.md       ✅ 交接说明
│  └─ adr/                      架构决策记录
├─ nuxt.config.ts               ✅ 冻结
├─ tsconfig.json                ✅ 冻结（Nuxt 生成的四工程引用）
├─ package.json / pnpm-lock.yaml ✅ 冻结
├─ .env.example / .gitignore    ✅ 冻结
└─ README.md                    安装与运行说明
```

**归属规则（硬性）**

| 范围 | 归谁 | 说明 |
| --- | --- | --- |
| `server/**` | 后端专家 | 前端**不得**改动，包括 `server/api`、`server/services`、`server/ai`、`server/db`、`server/tasks`、`server/plugins`、`server/utils`、`server/middleware` |
| `app/**` | 前端专家 | 后端**不得**改动 |
| `shared/**` | 双方共同 | 只追加；新增类型必须同步写进 `shared/types/index.ts` 的导出链（`export *`） |
| 冻结文件 | 无人可改 | 见 §1.3；需要变更时报给发起人 |
| `docs/**` | 各自追加 | 后端可加 `docs/adr/ADR-00x-*.md`；前端可加 `docs/ux-notes.md`；**不得改 design.md** |

---

## 4. 运行时、配置与私有数据

### 4.1 私有数据目录布局

```
<dataDir>/                         默认 D:\code\zhijuan\data（可由 NUXT_DATA_DIR 改到构建目录之外）
├─ db/
│  ├─ zhijuan.sqlite               主库
│  ├─ zhijuan.sqlite-wal           运行时自动出现，备份时必须一起处理
│  └─ zhijuan.sqlite-shm
└─ uploads/
   └─ <examId>/
      └─ <documentId>.<pdf|docx|txt|md>
```

- 目录由 `server/utils/paths.ts` 的 `ensureDataDirs()` 幂等创建，启动插件已调用；**不要在别处另造路径**。
- 资料文件路径在库中只保存**相对 `dataDir` 的路径**（如 `uploads/<examId>/<documentId>.pdf`），读取时用 `getStorageRoot()` 拼接，禁止把绝对路径写进库。
- 备份 = 停止进程后整目录复制（含 `-wal`/`-shm`）；恢复 = 反向复制。不要把 `data/` 放进 `.output` 或 `public/`。

### 4.2 runtimeConfig 与环境变量

| 配置键 | 默认 | 环境变量 | 说明 |
| --- | --- | --- | --- |
| `adminNames` | `['管理员']` | `NUXT_ADMIN_NAMES`（JSON 数组字符串） | 管理员名单，**私有**（不进 `public`） |
| `dataDir` | `'data'` | `NUXT_DATA_DIR` | 相对进程工作目录 |
| `sessionCookieName` | `'zj_session'` | `NUXT_SESSION_COOKIE_NAME` | 会话 Cookie 名 |
| `sessionTtlDays` | `7` | `NUXT_SESSION_TTL_DAYS` | 会话有效期（绝对时长，不滑动续期） |

- 模型 Base URL / API Key / 模型 ID **不进环境变量、不进代码**：存 `provider_settings` 表，由管理端设置页维护，读取接口只返回 `hasApiKey`（design §2.2）。
- 新环境首次启动：复制 `.env.example` 为 `.env`，改 `NUXT_ADMIN_NAMES` 即新增管理员；改完重启进程生效。

### 4.3 端口与部署

- 开发：`pnpm dev` → `http://localhost:4310`。
- 生产：`pnpm build` → `.output/`，`PORT=4310 node .output/server/index.mjs`，nginx 反向代理到该端口（**不是静态 dist**）。
- SQLite 驱动为 Node 内置，`.output` 可整目录搬同平台机器；`data/` 必须独立于 `.output` 单独备份。
- 内网 HTTP 下 Cookie 不加 `Secure`；只有检测到 HTTPS（`x-forwarded-proto: https` 或直连 TLS）才加（design §3.2）。

### 4.4 设计令牌（`app/assets/styles/main.css`，只允许追加）

`--zj-primary #15803d`、`--zj-bg #f7f9f7`、`--zj-text #17211b`、`--zj-text-muted`、`--zj-border`、`--zj-danger`、`--zj-radius`、`--zj-font`（本机中文字体栈）、`--zj-mono`。另有 `.zj-tabular`（等宽数字）、`.zj-muted`、`prefers-reduced-motion` 全局降级。

### 4.5 TypeScript 基线

- `strict: true`；Nuxt 4 默认开启 `noUncheckedIndexedAccess`，数组/Record 下标取值为 `T | undefined`，实现时显式判空。
- 路径别名：`~/` = `app/`，`#shared/` = `shared/`（`.nuxt/tsconfig.{app,server}.json` 均已生成）。前端引用共享类型写 `import type { … } from '#shared/types'`；后端写 `from '../../shared/types/…'` 亦可，以能通过 `pnpm typecheck` 为准。

---

## 5. 身份、会话、授权与安全

### 5.1 姓名规范化（唯一实现：`server/services/session.ts` 导出 `normalizeName`）

```
normalizeName(raw):
  1. 若 typeof raw !== 'string' → INVALID_NAME
  2. name = raw.normalize('NFC').trim()
  3. 长度（Unicode 码点计数，Array.from(name).length）必须在 1..64 → 否则 INVALID_NAME
  4. 保留大小写与中间空格，不做大小写折叠
  返回 name
```

- `name_key` 就是 `normalizeName` 的结果，原样入库（`attempts.name_key`、`sessions.name_key`）。
- 管理员判定：`normalizeName(candidate) === normalizeName(entry)` 与 `runtimeConfig.adminNames` 任一项**全等**。每次请求实时计算，不存库，改名单即时生效。
- 同一规范化姓名在一场内只有一份答卷：`UNIQUE(exam_id, name_key)`。

### 5.2 会话

- 登录：`POST /api/auth/login` 校验姓名 → 生成会话 → `Set-Cookie`。
- 会话 ID：`crypto.randomBytes(32).toString('base64url')`（43 字符，不可预测）。**不要**用姓名或自增 ID 当凭证。
- 写入 `sessions(id, name, name_key, created_at, expires_at)`，`expires_at = now + sessionTtlDays*86400_000`。
- Cookie 属性：`HttpOnly; Path=/; SameSite=Strict; Max-Age=<秒>`，HTTPS 时附 `Secure`；不设 `Domain`。
- 每次鉴权：读 Cookie → 查库 → 行不存在或 `expires_at <= now` 视为未登录（顺手删除该行）。**不滑动续期**。
- 角色：`admin`（名单命中）或 `candidate`，由服务端计算；客户端传 anything 都不影响。
- 登出：删除该会话行 + `Set-Cookie` 置空 `Max-Age=0`。
- 同一浏览器重新登录覆盖旧 Cookie；不清理其他会话（多设备登录互不影响）。

### 5.3 授权矩阵

| 路径前缀 | 要求 | 失败响应 |
| --- | --- | --- |
| `/api/auth/*` | 公开 | — |
| `/api/exams/*`、`/api/me/*`、`/api/attempts/*` | 已登录（任意角色） | `401 UNAUTHORIZED` |
| `/api/admin/**` | 已登录且 `role === 'admin'` | 无会话 `401 UNAUTHORIZED`；有会话非管理员 `403 FORBIDDEN` |
| `/api/health` | 公开 | — |

考生资源额外校验（**每个 attemptId 路由都必须做**）：答卷存在 && `attempt.name_key === session.name_key` && 场次匹配；任一不满足 → `404 NOT_FOUND`（不泄露他人答卷是否存在）。

### 5.4 写请求同源校验

所有 `POST/PUT/PATCH/DELETE`：

- 若请求带 `Origin` 头：解析 `URL(origin).host` 必须等于请求 `Host` 头，否则 `403 CSRF_ORIGIN_REJECTED`。
- 无 `Origin`（curl、服务间调用）放行。
- 该逻辑建议放 `server/middleware/10-origin-guard.ts` 统一执行；`/api/auth/login` 同样适用。

### 5.5 响应头与日志

- 所有 `/api/**` 响应带 `Cache-Control: no-store`（`server/utils/respond.ts` 的 `ok()`/`fail()` 已处理；自行 `return` 的 handler 必须手动设置）。
- 日志只允许：请求路径、状态码、耗时、任务 ID、脱敏错误摘要。**禁止**记录 API Key、完整 Authorization、完整试卷、考生姓名以外的个人信息；错误信息截断到 500 字符。

---

## 6. 接口通用约定

### 6.1 外壳

- 成功：HTTP 200/201/202 + `{ "data": <T> }`（`ApiSuccess<T>`）。
- 失败：HTTP 4xx/5xx + `{ "error": { "code": <ApiErrorCode>, "message": "中文可读说明", "details"?: any } }`（`ApiErrorBody`）。
- 导出接口例外：成功时直接返回 `.xlsx` 二进制流（`Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`），失败仍返回 JSON 错误外壳。
- `message` 必须能直接展示给用户，不要放英文堆栈或 SQL。

### 6.2 时间

- 传输与存储：**UTC 毫秒整数**（`EpochMs`，JSON number）。
- 入参中的场次时间：**带偏移的 ISO 8601**（`2026-10-24T09:00:00+08:00` 或 `...Z`）。正则必须匹配 `/([zZ]|[+-]\d{2}:\d{2})$/`，否则 `400 BAD_REQUEST`。禁止接收无偏移的本地时间字符串。
- 时区：`exams.time_zone` 存 IANA 名（`Asia/Shanghai`）。校验方式：`new Intl.DateTimeFormat('en-US', { timeZone })` 抛错即 `400 BAD_REQUEST`。
- 展示：前端一律用 `Intl.DateTimeFormat('zh-CN', { timeZone: exam.timeZone, … })`，并在界面标注时区；不依赖浏览器时区。
- 判定：一切"是否开始/是否截止"用服务端 `Date.now()`；客户端时间只用于显示，且必须在界面上以服务端时间校准（§10.3）。

### 6.3 分页

- 查询参数 `page`：正整数，缺省 1；非法 → `400 BAD_REQUEST`。
- 固定 `pageSize = 20`（`DEFAULT_PAGE_SIZE`）：考生「我的记录」、场次汇总考生列表、管理端场次列表。**不接受客户端自定义 pageSize**。
- 响应 `Paginated<T>`：`{ items, page, pageSize, total, totalPages }`；`totalPages = Math.max(1, Math.ceil(total / pageSize))`，越界页返回空 `items` 而不是报错。

### 6.4 文本上限（`shared/constants.ts`，服务端强校验，前端设 `maxlength`）

| 字段 | 上限 |
| --- | --- |
| 姓名 | 64 |
| 场次标题 | 200 |
| 考试说明 | 4000 |
| 题干 | 2000 |
| 单个选项文本 | 500 |
| 解析 | 2000 |
| 出题补充说明 | 2000 |
| 改分原因 | 500 |
| 引用摘录 `quote` | 500（归一化后 ≥10） |
| 填空每空作答 | 20（`MAX_BLANK_ANSWER_CHARS`） |

超限 → `422 VALIDATION_FAILED`，`details.fields` 形如 `{ "title": "标题不能超过 200 字" }`。

### 6.5 错误码全表（`ApiErrorCode`，状态码固定）

| code | HTTP | 触发场景 |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | 参数缺失/不可解析、页码非法、body 不是对象、时间无偏移 |
| `INVALID_JSON` | 400 | body 非法 JSON |
| `INVALID_NAME` | 400 | 姓名为空或超过 64 字符 |
| `UNAUTHORIZED` | 401 | 无会话、会话过期 |
| `FORBIDDEN` | 403 | 非管理员访问 `/api/admin/**` |
| `CSRF_ORIGIN_REJECTED` | 403 | 写请求 Origin 与 Host 不一致 |
| `NOT_FOUND` | 404 | 资源不存在，或考生访问不属于自己的答卷/场次 |
| `VERSION_CONFLICT` | 409 | `expectedVersion` ≠ 当前 `version`；`details: { serverVersion }` |
| `EXAM_TIME_CONFLICT` | 409 | 发布时与已发布场次时间重叠；`details: { conflicts: [...] }` |
| `EXAM_NOT_OPEN` | 409 | 开始作答时无开放场次或尚未开始；`details: { nextExam }` |
| `EXAM_CLOSED` | 409 | 已过截止时间的作答写入；`details: { submitReason: 'deadline', attemptId }` |
| `EXAM_LOCKED` | 409 | 已发布场次的禁止操作；`details: { reason }` |
| `EXAM_HAS_ATTEMPTS` | 409 | 已有答卷时删除/撤回 |
| `EXAM_NOT_PUBLISHED` | 409 | 对草稿执行发布专属操作 |
| `EXAM_HAS_ACTIVE_JOB` | 409 | 出题任务进行中时改题/改资料/再建任务 |
| `ALREADY_SUBMITTED` | 409 | 已交卷答卷收到答案写入 |
| `ATTEMPT_NOT_SUBMITTED` | 409 | 管理端查看/改分未交卷答卷 |
| `JOB_BUSY` | 409 | 全局已有 `running` 任务 |
| `JOB_NOT_RETRYABLE` | 409 | 任务不是 `failed` |
| `JOB_INPUT_STALE` | 409 | 重试时草稿版本或资料集合已变 |
| `DOCUMENT_IN_USE` | 409 | 删除的资料被题目引用 |
| `MODEL_NOT_CONFIGURED` | 409 | 缺 Base URL / Key / 模型 ID |
| `VALIDATION_FAILED` | 422 | 字段校验失败；`details.fields` |
| `ANSWER_INVALID` | 422 | 答案结构、选项 ID、空位 ID 非法 |
| `QUESTION_SET_INVALID` | 422 | 题目不满足题型规则（§7.4） |
| `PUBLISH_PRECHECK_FAILED` | 422 | 发布预检未通过；`details.checks: PublishChecklistItem[]` |
| `FILE_TYPE_UNSUPPORTED` | 422 | 扩展名或实际格式不符 |
| `FILE_TOO_LARGE` | 422 | 单份 > 20MB |
| `FILE_LIMIT_EXCEEDED` | 422 | 场次资料超过 5 份 |
| `FILE_PARSE_FAILED` | 422 | 加密 PDF、扫描件、损坏文件、无正文 |
| `DOCUMENT_CHARS_EXCEEDED` | 422 | 合并正文超过 40000 字符；`details: { currentChars, incomingChars, limit }` |
| `INVALID_BASE_URL` | 422 | Base URL 非 `http/https` 或无法解析 |
| `UPSTREAM_ERROR` | 502 | 模型返回非 2xx（非鉴权/限流） |
| `UPSTREAM_AUTH` | 502 | 模型 401/403 |
| `UPSTREAM_RATE_LIMIT` | 502 | 模型 429 |
| `UPSTREAM_TIMEOUT` | 504 | 单次调用超过 120s |
| `UPSTREAM_INVALID_RESPONSE` | 502 | 空内容、非 JSON、缺字段 |
| `INTERNAL_ERROR` | 500 | 未预期异常（响应不得包含堆栈） |

状态码与 `API_ERROR_STATUS` 常量必须一致；不要自造状态码。

---

## 7. 领域模型与算法

表结构见 `server/db/migrations/001-init.ts`（已应用）。以下是必须遵守的语义与算法。

### 7.1 计分单位

- 1 单位 = 0.01 分，整卷 `10000`（`SCORE_TOTAL_UNITS`），及格 `6000`（`PASS_SCORE_UNITS`）。
- 库内一切分值列都是整数单位；**禁止**用浮点存分。
- 展示：`(units / 100).toFixed(2)`；导出 Excel 时写**数值**（`units / 100`）并设两位小数格式。

### 7.2 配分算法（唯一实现，后端 `server/services/grading.ts`）

```ts
export function allocateUnits(totalUnits: number, count: number): number[] {
  if (!Number.isInteger(totalUnits) || totalUnits <= 0) throw new Error('totalUnits 非法')
  if (!Number.isInteger(count) || count <= 0) throw new Error('count 非法')
  const base = Math.floor(totalUnits / count)
  const remainder = totalUnits % count
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0))
}
```

- 整卷：`allocateUnits(10000, questionCount)`，按 `position` 升序赋给每题。
- 填空：`allocateUnits(question.maxScoreUnits, blankCount)`，按空位顺序赋给每空；各空之和必须等于该题满分。
- 示例：1 题 → `[10000]`；3 题 → `[3334, 3333, 3333]`；30 题 → 前 10 题 334、其余 333；100 题 → 各 100。
- **任何写题目的路径（AI 落库、整体保存）都必须服务端重算**，忽略客户端传来的分值。

### 7.3 判分算法

设 `normalizeBlank(input, caseSensitive)`：

```ts
const base = input.normalize('NFC').trim().replace(/\s+/gu, ' ')
return caseSensitive ? base : base.toLowerCase()
```

逐题：

| 题型 | 满分条件 | 否则 |
| --- | --- | --- |
| `single_choice` | `selectedOptionIds` 恰好为 1 个且等于唯一正确项 | 0 |
| `multiple_choice` | 选中集合与 `correctOptionIds` **完全一致**（漏选/错选/多选均 0，无部分分） | 0 |
| `true_false` | 选中集合等于唯一正确项 | 0 |
| `fill_blank` | 每个空：`values[blankId]` 归一化后命中该空 `acceptedAnswers` 任一项（同样归一化）→ 得该空分值；逐空累加 | 未命中的空计 0 |

- 未作答（`answer_json IS NULL`）→ 0 分，且结果页标「未作答」。
- 答案结构校验失败（选项不存在、空位不存在、空值超 20 字符、题型不匹配）→ `422 ANSWER_INVALID`，整个请求不落库。
- 全部由服务端计算；客户端提交的任何分值字段一律忽略（DTO 里也没有）。

### 7.4 题目结构合法性（`QUESTION_SET_INVALID`）

| 题型 | 规则 |
| --- | --- |
| `single_choice` | `options` 恰 4 项，ID 固定 `A,B,C,D`，文本非空且 ≤500；`correctOptionIds` 恰 1 项且在选项中；`blanks` 为空 |
| `multiple_choice` | 同上 4 项；`correctOptionIds` 长度 2..3（≥2 且 ≠4）；`blanks` 为空 |
| `true_false` | `options` 固定 `[{id:'true',text:'正确'},{id:'false',text:'错误'}]`；`correctOptionIds` 恰 1 项（`true` 或 `false`）；`blanks` 为空 |
| `fill_blank` | `options` 为空；`blanks` 至少 1 个；`blanks[].id` 稳定唯一（`b1`,`b2`,…）；每个 `acceptedAnswers` 非空且去重、每项 ≤20 字符；`caseSensitive` 缺省 `true` |

通用：`stem` 非空 ≤2000；`explanation` 非空 ≤2000；`sourceRefs` 至少 1 条，且 `documentId` 属于本场次、定位存在、`quote` 归一化后 ≥10 且命中该定位段落（§11.4）。题干对填空的可选占位符写作 `{{b1}}`，若出现则与实际空位一一对应。

### 7.5 场次阶段

```ts
function examPhase(exam: { status: 'draft' | 'published'; startsAt: number; endsAt: number }, now: number) {
  if (exam.status === 'draft') return 'draft'
  if (now < exam.startsAt) return 'upcoming'
  if (now < exam.endsAt) return 'open'
  return 'closed'
}
```

- 库里**只有** `draft` / `published` 两种状态；`upcoming/open/closed` 是计算值，不得入库。
- 时间重叠判定（半开区间）：`a.startsAt < b.endsAt && a.endsAt > b.startsAt` 即冲突，相邻（`a.endsAt === b.startsAt`）不算冲突。

### 7.6 表与字段语义

**provider_settings**（单行，`id = 1`）

| 列 | 语义 |
| --- | --- |
| `base_url` | 完整前缀，如 `https://model.example/v1`；末尾斜杠由服务端规范化（只去掉多余末尾 `/`，不自动补 `/v1`） |
| `api_key` | 明文 Bearer Key，仅服务端使用；读取接口只返回 `hasApiKey`；`NULL` 表示未配置 |
| `model_id` | 当前选用模型 ID；刷新模型列表不自动改它 |
| `updated_at` | UTC ms |

**exams**：`title`、`instructions`、`status`、`starts_at`、`ends_at`、`time_zone`、`answer_reveal_policy`（默认 `immediate`）、`blueprint_json`（`BlueprintDTO`）、`version`（乐观锁，任何成功写入 +1）、`published_at`、`created_at`、`updated_at`。
`CHECK (ends_at > starts_at)`。

**documents**：一条 = 一个上传文件。`storage_path` 为相对 `dataDir` 路径；`char_count` 为提取正文字符数；`segment_count` 为定位段数；`status` 当前实现恒为 `parsed`（解析失败**不落库**，返回 `422 FILE_PARSE_FAILED`，并删除已写文件，避免占用 5 份配额）。

**document_segments**：定位段表。`locator` 格式：PDF `p12`（第 12 页）、DOCX `para7`（第 7 段）、TXT/MD `line12`（第 12 行）；`seq` 从 1 递增；`start_offset`/`end_offset` 为在全文中的字符偏移；`text` 为该段原文。`UNIQUE(document_id, locator)`。

**questions**：`position` 从 1 连续递增（整卷顺序），`UNIQUE(exam_id, position)`；`options_json` 为 `QuestionOption[]`；`answer_definition_json` 为 `AnswerDefinition`；`source_refs_json` 为 `SourceRef[]`；`max_score_units` 由服务端配分写入。

**attempts**：`name` 为规范化姓名，`name_key` 为其副本用于唯一约束；`status` 只有 `in_progress|submitted`；`submitted_at` 截止交卷时**写入 `exams.ends_at`**（不是当前时间）；`submit_reason` 为 `manual|deadline`；`total_score_units` 交卷时写入；`version` 每次答案写入/改分/交卷 +1。

**answers**：`(attempt_id, question_id)` 主键；`answer_json` 为 `CandidateAnswer | NULL`（NULL = 未作答）；`auto_score_units` 为自动判分；`override_score_units` 为人工覆盖（NULL = 未覆盖）；最终分 = `COALESCE(override, auto)`。

**jobs**：`type` 恒 `'generation'`；`input_version` 为创建时的 `exams.version`；`input_json` 存 `{ blueprint, documentIds, difficulty, extraPrompt }`；`progress_total/progress_done` 为批次数；`model_id`/`base_url` 为任务开始时实际使用的值；`error_code`/`error_message` 为脱敏失败原因。部分唯一索引 `uq_jobs_active_exam` 保证同场次只有一个 `queued|running` 任务。

**sessions**：`id` 为 43 字符 base64url；`name`/`name_key` 为登录姓名；`expires_at` 到期即失效。

**grade_changes**：追加式审计，一条 = 一次人工改分：`previous_score_units`（改前最终分）、`new_score_units`（改后最终分）、`reason`、`admin_name`（改分管理员规范化姓名）、`created_at`。

**索引/约束**：外键在每个连接上 `PRAGMA foreign_keys = ON`（`server/utils/db.ts` 已设）；`attempts(exam_id, name_key)` 唯一；`questions(exam_id, position)` 唯一；`answers` 复合主键；迁移版本记录在 `schema_migrations`。

---

## 8. 接口契约

统一前缀 `/api`。下表 `Auth` 列：`—` 公开、`U` 已登录、`A` 管理员。所有时间字段类型为 `EpochMs`。

### 8.1 总表

| # | 方法 | 路径 | Auth | 请求 | 成功响应 |
| --- | --- | --- | --- | --- | --- |
| 1 | POST | `/api/auth/login` | — | `LoginRequest` | `200 LoginResultDTO` |
| 2 | GET | `/api/auth/session` | — | — | `200 SessionDTO` |
| 3 | POST | `/api/auth/logout` | U | — | `200 LogoutResultDTO` |
| 4 | GET | `/api/exams/current` | U | — | `200 CurrentExamDTO` |
| 5 | GET | `/api/me/attempts` | U | `?page` | `200 Paginated<MyAttemptRowDTO>` |
| 6 | POST | `/api/attempts/start` | U | — | `201/200 AttemptStartResult` |
| 7 | GET | `/api/attempts/:id` | U | — | `200 AttemptDetailDTO` |
| 8 | PATCH | `/api/attempts/:id/answers/:questionId` | U | `AnswerSaveRequest` | `200 AnswerSaveResult` |
| 9 | POST | `/api/attempts/:id/submit` | U | `SubmitRequest` | `200 SubmitResult` |
| 10 | GET | `/api/attempts/:id/result` | U | — | `200 AttemptResultDTO` |
| 11 | GET | `/api/admin/overview` | A | — | `200 AdminOverviewDTO` |
| 12 | GET | `/api/admin/settings` | A | — | `200 SettingsDTO` |
| 13 | PUT | `/api/admin/settings` | A | `SettingsUpdateRequest` | `200 SettingsDTO` |
| 14 | POST | `/api/admin/models/refresh` | A | — | `200 ModelRefreshResult` |
| 15 | GET | `/api/admin/exams` | A | `?page&status&keyword` | `200 Paginated<ExamListRowDTO>` |
| 16 | POST | `/api/admin/exams` | A | `ExamCreateRequest` | `201 ExamAdminDTO` |
| 17 | GET | `/api/admin/exams/:id` | A | — | `200 ExamAdminDTO` |
| 18 | PATCH | `/api/admin/exams/:id` | A | `ExamUpdateRequest` | `200 ExamAdminDTO` |
| 19 | DELETE | `/api/admin/exams/:id` | A | — | `200 { ok: true }` |
| 20 | POST | `/api/admin/exams/:id/documents` | A | `multipart/form-data`，字段 `file` | `201 DocumentDTO` |
| 21 | GET | `/api/admin/exams/:id/documents/:documentId/preview` | A | `?offset&limit` | `200 DocumentPreviewDTO` |
| 22 | DELETE | `/api/admin/exams/:id/documents/:documentId` | A | — | `200 { ok: true }` |
| 23 | POST | `/api/admin/exams/:id/generate` | A | `GenerateRequest` | `202 JobDTO` |
| 24 | PUT | `/api/admin/exams/:id/questions` | A | `QuestionsSaveRequest` | `200 ExamAdminDTO` |
| 25 | POST | `/api/admin/exams/:id/publish` | A | — | `200 ExamAdminDTO` |
| 26 | POST | `/api/admin/exams/:id/unpublish` | A | — | `200 ExamAdminDTO` |
| 27 | GET | `/api/admin/exams/:id/results` | A | `?page&name&passed&manual` | `200 ResultsPageDTO` |
| 28 | GET | `/api/admin/exams/:id/results/export` | A | `?name&passed&manual` | `200 .xlsx` 二进制 |
| 29 | GET | `/api/admin/attempts/:id` | A | — | `200 AttemptAdminDTO` |
| 30 | PATCH | `/api/admin/attempts/:id/answers/:questionId/grade` | A | `GradeRequest` | `200 GradeResult` |
| 31 | GET | `/api/admin/jobs/:id` | A | — | `200 JobDTO` |
| 32 | POST | `/api/admin/jobs/:id/retry` | A | — | `200 JobDTO` |
| 33 | GET | `/api/health` | — | — | `200 { ok, serverNow, schemaVersion }` |

> 所有 `/api/admin/**` 处理函数**第一行**必须是管理员断言；所有 `/api/attempts/**` 必须先做归属校验（§5.3）。

### 8.2 身份接口

**1. `POST /api/auth/login`**

- 入参：`{ name: string }`（`LoginRequest`）。
- 行为：`normalizeName(name)` → 写会话 → `Set-Cookie` → 判定角色。
- 出参：`LoginResultDTO`：`{ authenticated: true, name, role, landing, serverNow }`。
- `landing` 由服务端决定（避免前端各写一套）：
  - 管理员 → `'/admin'`
  - 考生 → `'/'`，前端登录成功后主动刷新考试安排，展示开始、续答或查看成绩入口，不自动建卷或跳入考试。
- 错误：`400 INVALID_NAME`、`400 BAD_REQUEST`。

**2. `GET /api/auth/session`**

- 出参 `SessionDTO`：`{ authenticated, name|null, role|null, serverNow }`。**不返回 401**（用于首屏探测）。
- 会话失效时同时清 Cookie（`Max-Age=0`）。

**3. `POST /api/auth/logout`** → `{ ok: true }`，删除会话行并清 Cookie。

### 8.3 考生接口

**4. `GET /api/exams/current`** → `CurrentExamDTO`

- `phase`：`open | upcoming | closed | none`。`open` 时 `exam` 为当前开放场次；`upcoming` 时 `exam=null`、`nextExam` 为下一场；`closed` 时 `exam` 为**最近刚结束**的一场（用户可能需要看结果）；两者都没有 → `none`。
- `myAttempt` 为**当前 `exam`** 的本人答卷摘要（存在则返回）；`nextExam` 不附带答卷。
- 调用前先对该用户的过期进行中答卷做截止结算（§11.3）。

**5. `GET /api/me/attempts?page=1`** → `Paginated<MyAttemptRowDTO>`，按 `started_at DESC, id DESC` 排序，仅本人。

**6. `POST /api/attempts/start`**

- 无请求体。考生点击「开始答题」后调用；续答或刷新已进入的答题页时可幂等调用。登录和刷新首页不调用，不创建答卷或开始计时。
- 先结算该用户在本场的过期进行中答卷，再分支：
  - 有开放场次 + 无本人答卷 → 事务内插入 `attempts`（`status='in_progress'`，`started_at=now`，`version=1`）→ `201 { attemptId, examId, status:'in_progress', startedAt, resumed:false }`
  - 有未交卷答卷 → `200 { …, status:'in_progress', resumed:true }`（**不重置 startedAt**）
  - 已交卷 → `200 { …, status:'submitted', resumed:true }`（前端跳结果页）
  - 无开放场次 → `409 EXAM_NOT_OPEN`，`details: { nextExam: ExamPublicDTO | null }`
- 并发安全：`INSERT` 依赖 `UNIQUE(exam_id, name_key)`，捕获冲突后回读已有答卷按"续答"返回（不要把唯一约束错误抛成 500）。

**7. `GET /api/attempts/:id`** → `AttemptDetailDTO`

- 返回：场次公开信息、`questions: CandidateQuestion[]`（**无答案、无解析、无资料原文**）、`answers: AnswerMap`、`version`、`serverNow`、`startedAt`、`status`。
- 若该答卷已过截止但仍为 `in_progress`：先执行截止结算，再返回（`status='submitted'`，`submittedAt=endsAt`），前端据此跳结果页。
- 错误：`404 NOT_FOUND`（不存在/不属于本人）、`401`。

**8. `PATCH /api/attempts/:id/answers/:questionId`**

- 入参 `AnswerSaveRequest`：`{ expectedVersion: number, answer: CandidateAnswer | null }`。
- 事务：校验答卷归属 → 校验 `status='in_progress'` → 校验 `now < exams.endsAt` → 校验 `attempts.version === expectedVersion` → 校验答案结构 → UPSERT `answers` → `attempts.version += 1`。
- 出参：`{ version: 新版本, savedAt: now }`。
- 空答案语义：`null`、`selectedOptionIds: []`、或填空所有值为空串 → `answer_json = NULL`（未作答）。
- 错误：`409 VERSION_CONFLICT`（`details.serverVersion`）、`409 EXAM_CLOSED`（`details.submitReason='deadline'`，且此时已完成结算）、`409 ALREADY_SUBMITTED`、`422 ANSWER_INVALID`、`404`、`401`。

**9. `POST /api/attempts/:id/submit`**

- 入参 `SubmitRequest`：`{ expectedVersion, answers: AnswerMap }`（**完整快照**）。
- 事务（design §7.1，短事务）：归属校验 → 已交卷则直接返回既有结果（`duplicate: true`）→ `expectedVersion` 校验 → `now >= endsAt` 则改为截止结算（不采纳快照，`acceptedSnapshot: false`）→ 校验快照结构 → 全量覆盖 `answers` → 判分 → 写 `total_score_units`、`status='submitted'`、`submitted_at=now`、`submit_reason='manual'`、`version+=1`。
- 出参 `SubmitResult`：`{ attemptId, status:'submitted', submittedAt, submitReason, acceptedSnapshot, totalScoreUnits, version, duplicate }`。
- 错误：`409 VERSION_CONFLICT`、`422 ANSWER_INVALID`、`404`、`401`。重复提交**不是错误**（`200 duplicate:true`，不重复计分、不改写分数）。

**10. `GET /api/attempts/:id/result`** → `AttemptResultDTO`

- `canReveal = status==='submitted' && (policy==='immediate' || now >= exam.endsAt)`。
- `canReveal=false`：`questions = null`，只返回 `answers`、`totalScoreUnits`、用时、`revealAt`（`immediate` → `submittedAt`；`after_exam` → `endsAt`）。**禁止**下发标准答案/逐题得分/对错标志，也禁止"下发整卷让前端隐藏"。
- `canReveal=true`：`questions` 返回逐题 `QuestionResultDTO`（含 `userAnswer`、`earnedScoreUnits`、`autoScoreUnits`、`overrideScoreUnits`、`manualReviewed`、`unanswered`、`correctAnswer`、`explanation`、`sourceRefs`）。
- 错误：未交卷 → `409 ATTEMPT_NOT_SUBMITTED`（前端应回作答页）；`404`；`401`。

### 8.4 设置与模型

**12. `GET /api/admin/settings`** → `SettingsDTO`：`{ baseUrl, modelId, hasApiKey, updatedAt }`。**永不返回 `apiKey`**。

**13. `PUT /api/admin/settings`**（`SettingsUpdateRequest`）

- `baseUrl`：可选；必须 `http(s)://` 可解析，否则 `422 INVALID_BASE_URL`；只去掉末尾多余 `/`。
- `apiKey`：`undefined`（字段缺失）= 保持；`null` = 清除；非空字符串 = 替换。掩码值（全 `*`）→ `400 BAD_REQUEST`。
- `modelId`：字符串或 `null`。
- 出参 `SettingsDTO`。事务内 UPSERT `id=1`。

**14. `POST /api/admin/models/refresh`** → `ModelRefreshResult`

- 调 `GET {baseUrl}/models`（`Authorization: Bearer <key>`，超时 120s），读 `data[].id` 去重排序。
- 不修改已选 `modelId`；未配置 Base URL/Key → `409 MODEL_NOT_CONFIGURED`；上游错误按 §6.5 映射。

### 8.5 场次管理

**15. `GET /api/admin/exams?page&status&keyword`** → `Paginated<ExamListRowDTO>`

- `status`：`draft|published` 可选；`keyword`：标题包含匹配（不区分大小写，≤100 字符）。
- 排序：`updated_at DESC, id DESC`。

**16. `POST /api/admin/exams`**（`ExamCreateRequest`）

- 缺省：`title` 为场次时区当天日期加「测试」（例如 `2026年10月26日 测试`）、`instructions=''`、`answerRevealPolicy='immediate'`、`blueprint=EMPTY_BLUEPRINT`、`status='draft'`、`version=1`。前端打开新建弹窗时预填名称，服务端在标题为空时也使用此规则。
- 时间缺省：`timeZone` 默认 `Asia/Shanghai`，支持显式传入其它合法 IANA 时区；`startsAt` = 该时区**今天 00:00**，`endsAt` = 次日 00:00。只影响新场次，不重写已有场次。
- 返回 `201 ExamAdminDTO`（`questions=[]`、`documents=[]`、`activeJob=null`、`publishChecklist` 已计算）。

**17. `GET /api/admin/exams/:id`** → `ExamAdminDTO`（含 `questions`、`documents`、`activeJob`、`publishChecklist`、`serverNow`）。

**18. `PATCH /api/admin/exams/:id`**（`ExamUpdateRequest`）

- 仅 `status='draft'` 且无活动任务；已发布 → `409 EXAM_LOCKED`（`details.reason='published'`）；有活动任务 → `409 EXAM_HAS_ACTIVE_JOB`。
- `expectedVersion` 必须匹配，否则 `409 VERSION_CONFLICT`。
- 时间字段为带偏移 ISO 字符串；改完仍须满足 `endsAt > startsAt`，否则 `422 VALIDATION_FAILED`。
- 时间冲突**允许保存**（草稿），但 `publishChecklist` 中标记未通过；发布时才硬拦。
- `blueprint` 各题型数量 0..100、合计 0..100（草稿允许 0 题）。
- 成功：`version += 1`，返回 `ExamAdminDTO`。

**19. `DELETE /api/admin/exams/:id`**

- 前置：`status='draft'` 且 `attemptCount === 0`，否则 `409 EXAM_LOCKED` / `409 EXAM_HAS_ATTEMPTS`。
- 级联删除题目/资料/任务（迁移已配置 `ON DELETE CASCADE`；`attempts` 为 `RESTRICT`），并删除 `uploads/<examId>/` 目录。
- 返回 `{ ok: true }`。

**20. `POST /api/admin/exams/:id/documents`**（`multipart/form-data`，字段名 `file`）

- 前置：草稿、无活动任务、资料数 <5。
- 校验顺序：文件数 → 扩展名（`pdf|docx|txt|md`，且大小写不敏感）→ 单份 ≤20MB → 实际格式（PDF 头 `%PDF-`、DOCX 为 zip 且含 `word/document.xml`、TXT/MD 尝试 UTF-8 解码）→ 解析正文 → 合并字数 ≤40000。
- 文件写入 `uploads/<examId>/<documentId>.<ext>` 后，在同一事务写 `documents` + `document_segments`；任一步失败删除已写文件并返回 4xx。
- 返回 `201 DocumentDTO`。
- 错误：`422 FILE_TYPE_UNSUPPORTED | FILE_TOO_LARGE | FILE_LIMIT_EXCEEDED | FILE_PARSE_FAILED | DOCUMENT_CHARS_EXCEEDED`、`409 EXAM_LOCKED | EXAM_HAS_ACTIVE_JOB`、`404`。

**21. `GET /api/admin/exams/:id/documents/:documentId/preview?offset=0&limit=4000`**

- `offset ≥ 0`、`1 ≤ limit ≤ 4000`（默认 4000），非法 → `400 BAD_REQUEST`。
- 返回 `DocumentPreviewDTO`：全文总字数、片段文本、`truncated`。
- 用于"先预览再生成"；不得返回文件系统绝对路径。

**22. `DELETE /api/admin/exams/:id/documents/:documentId`**

- 若任一题目 `source_refs_json` 引用该资料 → `409 DOCUMENT_IN_USE`（`details: { questionIds: string[] }`）。
- 已发布 → `409 EXAM_LOCKED`；有活动任务 → `409 EXAM_HAS_ACTIVE_JOB`。
- 删除库行（级联 segments）+ 删除文件；返回 `{ ok: true }`。

**23. `POST /api/admin/exams/:id/generate`**（`GenerateRequest`）

- 前置（任一不满足即拒）：
  - `status='draft'`；`expectedVersion === exam.version`
  - 无活动任务（`409 EXAM_HAS_ACTIVE_JOB`）
  - 已配置 baseUrl+apiKey+modelId（`409 MODEL_NOT_CONFIGURED`，`details.missing: string[]`）
  - 至少 1 份 `status='parsed'` 资料
  - blueprint 合计 1..100，且各题型数量 ≥0
  - 全局无 `running` 任务（`409 JOB_BUSY`；单进程同时只跑一个 AI 任务）
- 事务内插入 `jobs`（`queued`、`input_version=exam.version`、`input_json` 快照、`progress_total` 按批次预计算）→ `202 JobDTO`。
- 同一草稿的活动任务唯一性由 `uq_jobs_active_exam` 保证。

**24. `PUT /api/admin/exams/:id/questions`**（`QuestionsSaveRequest`）

- 前置：草稿、无活动任务、`expectedVersion` 匹配。
- 校验：每题按 §7.4；题数 0..100；`sourceRefs` 引用的资料必须属于本场且已解析。
- 服务端分配：新题 `id = crypto.randomUUID()`；`position = 数组下标+1`；按 §7.2 重算 `max_score_units`；空位 ID 若缺省按顺序补 `b1..bn`。
- 事务内整体替换（删除未出现的旧题）→ `version += 1` → 返回 `ExamAdminDTO`。
- 错误：`422 QUESTION_SET_INVALID`（`details: { index, questionId?, reason }`）、`409`、`404`。

**25. `POST /api/admin/exams/:id/publish`**

- 前置与预检（design §4.3），全部通过才落库；任一项失败 → `422 PUBLISH_PRECHECK_FAILED`，`details.checks` 为逐项结果，前端按此渲染预检面板：
  1. 标题非空、时间有效且 `endsAt > now`
  2. 题数 1..100
  3. 各题型数量与 `blueprint` 一致且合计一致
  4. 每题结构合法（§7.4）且引用有效
  5. 每题有标准答案、解析、资料引用
  6. 分值合计 = 10000
  7. 无活动任务（`queued|running`）
  8. 与已发布场次无时间冲突
- 冲突时同时返回 `409 EXAM_TIME_CONFLICT`（`details.conflicts`），或在预检项中标出；**实现取 409**（前端按 `code` 分支展示场次标题与时间）。
- 成功：`status='published'`、`published_at=now`、`version+=1`，返回 `ExamAdminDTO`。

**26. `POST /api/admin/exams/:id/unpublish`**

- 允许条件：`status='published'` 且 `now < startsAt` 且 `attemptCount === 0`。
- 否则：已开始/有答卷 → `409 EXAM_HAS_ATTEMPTS`（`details.reason='started'|'has_attempts'`）；草稿 → `409 EXAM_NOT_PUBLISHED`。
- 成功：`status='draft'`、`published_at=NULL`、`version+=1`，返回 `ExamAdminDTO`。

### 8.6 场次汇总

**27. `GET /api/admin/exams/:id/results?page&name&passed&manual`** → `ResultsPageDTO`

- `summary` 统计**全量**答卷（不受筛选影响）：参与人数 = 答卷总数；`inProgressCount`/`submittedCount`；平均/最高/最低/及格率只基于 `submitted`，无数据时为 `null`（前端显示「—」）；`questionStats[]` 为逐题正确/部分/零分人数与样本数（样本 = 已交卷数，未作答按 0 分计）。
- `items` 为筛选后的考生行，排序 `started_at DESC, id DESC`，每页 20。
- 筛选：`name` 为规范化后包含匹配；`passed='true'|'false'` 与 `manual='true'|'false'` **只作用于已交卷答卷**（筛选生效时不返回进行中行）。
- `durationMs`：已交卷 = `submittedAt - startedAt`；进行中 = `now - startedAt`。
- 所有查询必须带 `exam_id` 条件（跨场隔离）。

**28. `GET /api/admin/exams/:id/results/export?name&passed&manual`**

- 导出**跟随同一筛选**、不分页。
- 列（固定顺序）：`姓名`、`开始时间`、`交卷时间`、`用时（分钟）`、`总分`、`是否及格`、`是否人工复核`。
- 时间格式 `YYYY-MM-DD HH:mm:ss`（按 `exam.time_zone` 渲染）；`总分` 为数值、两位小数；`用时` 为数值 `round(ms/60000, 2)`；未交卷行：交卷时间空、用时为空、总分为空、及格为空。
- 文件名：`{title}-成绩汇总-{yyyyMMddHHmm}.xlsx`（`Content-Disposition` 用 RFC 5987 `filename*=UTF-8''…`）；sheet 名 = 标题截断 31 字符（去掉 `[]:*?/\\`）。
- 安全：姓名等文本以 `= + - @` 开头时前置 `'` 防公式注入；不得包含 API Key、会话、管理员名单。

### 8.7 答卷详情与改分

**29. `GET /api/admin/attempts/:id`** → `AttemptAdminDTO`

- 仅已交卷答卷可看（design §7.2 "概览不提供偷看未交卷输入"）：未交卷 → `409 ATTEMPT_NOT_SUBMITTED`。
- 返回完整题目（含标准答案、解析、引用）、本人答案、逐题 `auto/override/final`、全部 `gradeChanges`、`serverNow`。

**30. `PATCH /api/admin/attempts/:id/answers/:questionId/grade`**（`GradeRequest`）

- 入参：`{ expectedVersion, score: string, reason: string }`。
- 校验：答卷已交卷（否则 `409 ATTEMPT_NOT_SUBMITTED`）；题目属于该场；`score` 匹配 `/^\d+(\.\d{1,2})?$/` 且 `0 ≤ score*100 ≤ question.max_score_units`；`reason` 1..500 字符；`expectedVersion === attempts.version`。
- 事务：写/更新 `answers.override_score_units`（若改回自动分则置 NULL）→ 插入 `grade_changes`（`previous` = 改前最终分，`new` = 改后最终分）→ 重算 `attempts.total_score_units`（人工优先）→ `version+=1`。
- 出参 `GradeResult`。不得修改标准答案、题目满分、他人答卷。

**31/32. 出题任务**

- `GET /api/admin/jobs/:id` → `JobDTO`（含 `progressTotal/progressDone/errorCode/errorMessage/modelId/baseUrl`）；前端 1 秒轮询。
- `POST /api/admin/jobs/:id/retry`：
  - 任务状态必须 `failed`，否则 `409 JOB_NOT_RETRYABLE`
  - `job.input_version !== exam.version` 或资料集合已变（新增/删除资料）→ `409 JOB_INPUT_STALE`（提示重新生成）
  - 已有 `queued|running` 任务 → `409 JOB_BUSY`
  - 原子 `UPDATE jobs SET status='queued', progress_done=0, error_code=NULL, error_message=NULL, started_at=NULL, finished_at=NULL WHERE id=? AND status='failed'`
  - 返回 `200 JobDTO`。

---

## 9. 页面路由与数据来源

### 9.1 考生端

| 路由文件 | URL | Layout | 数据来源 | 关键行为 |
| --- | --- | --- | --- | --- |
| `app/pages/index.vue` | `/` | `default` | `GET /api/auth/session` → 未登录显示姓名登录卡片；考生登录成功后主动获取 `GET /api/exams/current` | 管理员进入管理端；考生查看考试信息，自行点击开始、续答或查看成绩；请求完成前显示加载状态，无考试时显示下一场时间与「我的记录」入口 |
| `app/pages/my-attempts.vue` | `/my-attempts` | `default` | `GET /api/me/attempts?page` | 每页 20，行点击 → 已交卷进结果页、进行中进作答页 |
| `app/pages/exams/[examId]/attempt.vue` | `/exams/:examId/attempt` | `default` | `GET /api/attempts/:id`（id 由 `POST /api/attempts/start` 得到） | 逐题作答、自动保存、正计时、交卷确认（§10） |
| `app/pages/attempts/[attemptId]/result.vue` | `/attempts/:attemptId/result` | `default` | `GET /api/attempts/:id/result` | 立即展示总分/用时/本人答案；`canReveal` 决定是否展示逐题解析；`after_exam` 显示公开时刻并在到时自动刷新 |
| 登录卡片组件 | 由 `index.vue` 内联或 `components/candidate/NameLoginCard.vue` | — | — | 姓名输入框 + 提交；错误时展示 `error.message` |

### 9.2 管理端

| 路由文件 | URL | Layout | 数据来源 |
| --- | --- | --- | --- |
| `app/pages/admin/index.vue` | `/admin` | `admin` | `GET /api/admin/overview` |
| `app/pages/admin/exams/index.vue` | `/admin/exams` | `admin` | `GET /api/admin/exams?page&status&keyword`、`POST /api/admin/exams` |
| `app/pages/admin/exams/[id]/index.vue` | `/admin/exams/:id` | `admin` | `GET /api/admin/exams/:id`、`PATCH`、`DELETE`、`POST /documents`、`DELETE /documents/:documentId`、`GET …/preview`、`POST /generate`、`PUT /questions`、`POST /publish`、`POST /unpublish`、`GET /jobs/:jobId`、`POST /jobs/:jobId/retry` |
| `app/pages/admin/exams/[id]/results.vue` | `/admin/exams/:id/results` | `admin` | `GET /api/admin/exams/:id/results`、导出下载 `…/results/export` |
| `app/pages/admin/attempts/[id].vue` | `/admin/attempts/:id` | `admin` | `GET /api/admin/attempts/:id`、`PATCH …/grade` |
| `app/pages/admin/settings.vue` | `/admin/settings` | `admin` | `GET/PUT /api/admin/settings`、`POST /api/admin/models/refresh` |

- `app/layouts/admin.vue`：左侧固定侧栏（概览 / 考试 / 模型设置）+ 顶部当前管理员姓名与登出；窄屏折叠为抽屉。
- 管理端页面**不需要**在客户端再判角色：接口会 403；但布局需在 403 时提示"需要管理员权限"并提供重新登录入口。

---

## 10. 前端实现硬性要求

### 10.1 API 调用层

- 统一封装在 `app/composables/useApi.ts`：`$fetch` + `credentials: 'same-origin'`，解析 `{data}` 与 `{error}`，抛出 `ApiClientError { code, message, details, status }`。
- 处理规则：`401` → 跳 `/` 并提示重新登录；`409 VERSION_CONFLICT` → 按 §10.4 冲突 UI；其余 → `ElMessage.error(error.message)` + 页面内联提示（表单类错误展示 `details.fields`）。
- 页面必须显式处理三态：`loading`（`el-skeleton`）、`empty`（`el-empty`）、`error`（可重试按钮）。**不得**用假数据填充。

### 10.2 作答页（design §6.2 / §6.3）

- 单题主视图 + 右侧/底部题号面板：当前/已答/未答三态；窄屏题号面板收进抽屉。
- 选项单击**只选中不跳题**；切题用上一题/下一题按钮或题号；最后一题显示「交卷」。
- 填空题每空下方标注该空分值；多选提示「可多选」；填空提示「每空最多 20 字」与「区分大小写」。
- 填空题对外显示的题干将 `{{b1}}` 等内部标识渲染为 `_____`，作答、结果和管理端预览保持一致；保存的题干、编辑字段及答案空位 ID 保持原格式，以便绑定和判分。判断题按钮以绿色勾、红色叉分别表示正确与错误，不把 `true` / `false` 作为图标文本。
- 交卷确认弹窗显示已答 X 题 / 未答 Y 题；允许空题交卷。

### 10.3 自动保存与计时

- 输入变化 600ms 防抖（`AUTOSAVE_DEBOUNCE_MS`）；保存状态三种展示：保存中 / 已保存（含时间）/ 保存失败 + 重试。
- **串行**保存队列：同一时刻只有一个 PATCH 在飞，后续变更排队；旧响应不得覆盖新输入（用本地版本号守卫）。
- 每次保存成功后用响应的 `version` 覆盖本地 `version`。
- 切题前若有未完成保存，必须 `await` 队列排空再切换；失败或冲突须结束等待，保留最新输入，并提供重试或冲突处理入口。
- `409 VERSION_CONFLICT`：暂停整个保存队列及后续防抖请求；弹窗提供「用服务器版本刷新」（确认后重新载入整份答卷并清理旧队列）与「复制全部未保存答案」，同时提供可手动复制的文本；**不得静默覆盖**，也不实现"用我的覆盖服务器"。
- 交卷：先排空保存队列，再 `POST /submit` 带本地完整快照 + 最新 `version`；若返回 `409 VERSION_CONFLICT`，刷新后让用户重新确认交卷。
- 计时：只显示已用时间 `HH:MM:SS`（`serverNow - startedAt`，`font-variant-numeric: tabular-nums`）。用「服务端时钟偏移」校准：`offset = serverNow - Date.now()`，显示 `Date.now() + offset - startedAt`。每 60 秒或 `visibilitychange` 时用一次轻量请求（`GET /api/attempts/:id`）重新同步；**不显示倒计时**。
- 后台同步不能覆盖本地未保存答案或推进其版本；请求期间发生保存/输入时，也不能用旧响应覆盖当前状态。
- 截止处理：本地时间到达 `endsAt` 时禁用输入并自动发起一次交卷；若服务端已结算（`EXAM_CLOSED`/`ALREADY_SUBMITTED`），直接跳结果页。
- `beforeunload` 有未保存内容时提示；页面不承诺离线恢复。

### 10.4 结果页（design §7.2）

- `canReveal=false`：展示总分（两位小数）、用时、是否及格、本人答案；逐题区域显示「答案与解析将在 {revealAt 按考试时区格式化}（{timeZone}）公开」，并在 `revealAt` 到时自动重新请求（同时监听 `visibilitychange`）。
- `canReveal=true`：逐题展示题干、本人答案、正确答案、解析、得分（含"人工复核"标记）；未作答显示「未作答」。
- 不出现「待批阅」等不存在状态。
- 延迟公开的等待使用响应中的 `serverNow` 校准，重新请求间隔至少 1 秒，不能因客户端时钟偏快形成无间隔请求。

### 10.5 管理端

- 场次编辑页分区顺序与 design §9.1 一致：基本信息 → 资料（上传/预览/删除）→ 题数与难度 → 出题（生成/进度/重试）→ 题目编辑 → 公开策略 → 发布/撤回。
- 出题进度：1 秒轮询 `GET /api/admin/jobs/:id`，显示 `progressDone/progressTotal`；失败显示 `errorMessage` 与「重试」；已有活动任务时禁用「生成」与其他编辑操作。
- 发布前必须调用 `GET /api/admin/exams/:id` 并用 `publishChecklist` 渲染预检清单；预检失败展示逐项原因。
- 题目编辑：按题型渲染；配分只读（显示服务端算好的分值）；新增/删除/上下移动题目；保存时为整体 `PUT`，提交前本地校验基本完整性。
- 保存其他卡片后保留未保存的题目草稿；若服务器题目也改变则阻止覆盖并提示处理冲突。选择题固定四个选项，不提供改变选项数量的控件。已有题目的草稿仍可确认后重新生成，失败保留服务器旧题目。
- 汇总页：顶部指标卡（参与/进行中/已交卷/平均/最高/最低/及格率，无数据显示「—」，平均等注明「基于 X 份已交卷答卷」）；考生表格每页 20；逐题表现表；筛选（姓名/及格/人工复核）与「导出 Excel」按钮（导出跟随当前筛选，用 `window.location`/`fetch` 下载流）。
- 改分弹窗：显示自动分、当前最终分；输入新分（0~满分，两位小数）与必填原因；成功后就地刷新总分与录像记录。

### 10.6 视觉与可达性（design §12）

- 正文 ≥16px；主按钮触控高度 ≥44px；输入框必须有可见标签；全键盘可达（Tab/Enter/方向键切换选项可选）。
- 使用 §4.4 的 CSS 变量；不要引入外部字体 CDN。
- 翻题过渡 150~200ms，且 `prefers-reduced-motion` 下由全局样式降级。
- 不引入新的 UI 库或动画库。

### 10.7 SSR 安全

- 任何答案、解析、评分字段只能来自 `/api` 响应；禁止在 `useAsyncData` 里直接查库。
- 不要用 `useState` 存放会话敏感信息的持久副本；会话以 `GET /api/auth/session` 为准。
- 首屏渲染前不得假设已登录（SSR 时 Cookie 可用，但页面需处理未登录分支）。

---

## 11. 后端实现硬性要求

### 11.1 通用

- 每个 handler：解析 → 鉴权（§5.3）→ 校验（zod 或手写）→ 业务 → `ok()`；异常用 `failFrom(event, error)` 收口（`server/utils/respond.ts`）。
- 所有写操作在 `withTransaction(db, () => …)` 内完成；**禁止**在事务内 `await` 模型调用。
- 事务内必须重新读取并校验：状态、`version`、服务端时间（design §11.3 末条）。
- 时间冲突/版本冲突/发布锁的判断全部在写事务内完成一次，不要只读一次再写。

### 11.2 出题任务执行（design §8.3 / §8.4）

- `server/tasks/generation-worker.ts`：Nitro 插件启动时 `setInterval` 每秒轮询；领取任务用单条原子 UPDATE：
  ```sql
  UPDATE jobs SET status='running', started_at=?, model_id=?, base_url=?
  WHERE id = (SELECT id FROM jobs WHERE status='queued' ORDER BY created_at LIMIT 1)
    AND status='queued'
  ```
  返回 `changes === 1` 才执行，保证单进程内不重复领取。
- 执行前重新读取草稿与资料；若 `exam.version !== job.input_version` 则任务失败（`JOB_INPUT_STALE` 语义）。
- 分批：按题型分组，候选数为 `max(count, min(ceil(count*1.5), 60))`，保证支持单一题型 61～100 题；单批题目数 ≤`MAX_BATCH_QUESTIONS`（=6）；`progress_total` = 批次数，每批成功 `progress_done += 1`。
- 单批重试：同一批次最多尝试 `BATCH_MAX_ATTEMPTS`（=2）次，仅对 `UPSTREAM_TIMEOUT`/`UPSTREAM_BAD_RESPONSE`/`UPSTREAM_INVALID_RESPONSE`/`QUESTION_SET_INVALID` 重试（模型输出漂移）；鉴权、限流、输入类错误不重试。引用摘录先尝试按资料原文回退修复（`repairSourceRefs`，见 §11.4），失败才计入该批错误。
- 任务时间戳一律在写入时刻取 `Date.now()`，不得复用领取任务时的时间快照（否则 `finished_at` 恒等于 `started_at`，界面耗时显示为 0）。
- 解析只允许：去掉整段 Markdown 代码围栏（` ```json … ``` `）后 `JSON.parse`；禁止 eval、禁止从文本中截取 `{...}`、禁止补默认字段。缺字段/多字段/类型不符一律视为该批失败。
- 服务端生成：题目/选项/空位 ID、`position`、`max_score_units`；把模型输出的临时空位编号（`{{1}}`、`[1]`、`__1__`）统一映射为 `b1..bn`，并同步替换题干与 `acceptedAnswers` 中的引用。
- 校验（§7.4）+ 引用校验（§11.4）+ 去重（同题干归一化后不得重复）通过后，**全部批次成功才在一个事务内写入**题目；任一关键批次失败 → 整任务失败，草稿题目保持原样，绝不写入半成品。
- 随机抽题：每题型候选打乱后取前 N；未抽中候选不落库。
- 任务失败：写 `error_code`（如 `UPSTREAM_TIMEOUT`/`UPSTREAM_INVALID_RESPONSE`/`QUESTION_SET_INVALID`）、脱敏 `error_message`（≤500 字符）、`finished_at`。进程重启时把遗留 `running` 标为 `failed`（`error_code='INTERRUPTED'`），`queued` 继续执行。

### 11.3 截止交卷（design §6.4）

- `server/tasks/deadline-sweeper.ts`：插件启动即执行一次，之后每秒：
  ```sql
  SELECT a.id FROM attempts a JOIN exams e ON e.id = a.exam_id
  WHERE a.status='in_progress' AND e.ends_at <= ?
  ```
- 对每份答卷在事务内结算：写入 `submitted_at = exams.ends_at`、`submit_reason='deadline'`、按**最后保存的答案**判分、`version += 1`；若该答卷已被用户手动交卷则跳过（幂等）。
- 访问过期答卷的接口（`GET /attempts/:id`、`PATCH …/answers`、`POST …/submit`、`POST /attempts/start`）必须先对**该答卷**单独结算再返回相应状态，不依赖后台定时器。
- 多份答卷逐条事务结算，避免一次大事务阻塞。

### 11.4 资料解析与引用校验

- PDF：`unpdf` 提取逐页文本，每页一个 segment（`p{n}`）；加密/无文本层（去空白后 <20 字符）→ `422 FILE_PARSE_FAILED`，`details.reason` 说明"加密 PDF / 扫描件 / 无可提取文本"。
- DOCX：`mammoth.extractRawText` 取正文，按空行分段（`para{n}`）；解压后文本 >200000 字符直接判失败（防压缩炸弹）。
- TXT/MD：严格 UTF-8 解码失败 → `422 FILE_PARSE_FAILED`；按行分段（`line{n}`），单行超长按 1000 字符切分（仍用首个行号定位）。
- 归一化（quote 命中判定唯一实现，`server/services/document.ts`）：
  ```
  normalizeDocText(s):
      s.normalize('NFC')
      去软连字符 \u00AD
      把 \r\n / \r 统一为 \n
      删除仅由数字/页码符号构成的行
      合并连续空白为单个空格
      trim
  ```
  命中规则：`normalizeDocText(segment.text).includes(normalizeDocText(quote))`，且 `normalizeDocText(quote).length >= 10`。
- `sourceRefs[].locator` 必须精确等于该资料已有 segment 的 `locator`；跨段引用不支持（要求模型拆成多条引用）。

### 11.5 模型调用（design §8.2）

- Base URL 规范化：`trim()` → 去掉末尾所有 `/`；仅接受 `http:`/`https:`；不自动追加 `/v1`。
- 列表：`GET {baseUrl}/models`；生成：`POST {baseUrl}/chat/completions`，body 最小 `{ model, messages, stream: false }`。
- 请求头：`Authorization: Bearer <apiKey>`（**API Key 为空时不发送该头**）、`Content-Type: application/json`；不发送其他自定义头。
- 超时：`AbortSignal.timeout(MODEL_REQUEST_TIMEOUT_MS)`（=300_000）；超时/网络错误 → `UPSTREAM_TIMEOUT`（超时）或 `UPSTREAM_ERROR`（网络）。
- 解析：`choices[0].message.content` 必须为非空字符串；否则 `UPSTREAM_INVALID_RESPONSE`。
- 错误映射：401/403 → `UPSTREAM_AUTH`；429 → `UPSTREAM_RATE_LIMIT`；其他非 2xx → `UPSTREAM_ERROR`（`details.status`）。
- 不自动重试、不自动换模型。任务开始时读取一次配置并写入 `jobs.model_id/base_url`，全程使用该组值。
- 日志不回显 Key 与完整 prompt。

### 11.6 导出

- 用 `exceljs` 的流式写出（`workbook.xlsx.write(res)`），不要先在内存拼大字符串。
- 设置表头加粗、冻结首行、列宽（姓名 16、时间 22、用时 12、总分 10、布尔列 12）。
- 文件名与公式注入防护见 §8.6。

### 11.7 初始化与幂等

- 首次启动自动建目录、建表（`server/plugins/database.ts` 已做）；**不得**要求人工执行 SQL。
- `provider_settings` 首次读取不存在时返回 `{ baseUrl:'', modelId:null, hasApiKey:false, updatedAt:null }`，不要因此 500。
- 所有"首次访问"路径（无场次、无资料、无题目、无答卷、无汇总数据）都必须返回合法空结构而不是错误。

---

### 11.8 出题任务实时输出与思考强度（§8.7 31 / §8.4 12）

- **目的**：管理员能在场次页看到模型正在吐出的原始文本（排查"生成质量差/卡的哪一步"），不是给考生看的。
- 采集：出题任务调用模型时传 `onDelta`，走 `stream: true` 的 SSE；`choices[0].delta.reasoning_content`（思考片段）与 `delta.content`（正文）都按到达顺序写入，`[DONE]` 结束；正文片段同时拼成完整字符串交给 `parseBatchResponse`，思考片段不参与解析。
- 上游忽略 `stream:true` 直接回整段 JSON 时，一次性回调整段文本，行为与流式一致；流中途断开按上游异常处理，已收到的片段不丢。
- 落库：`jobs.output_text` 只保留最近 `JOB_OUTPUT_MAX_CHARS`（=60000）字符（`substr(…, -N)`），`jobs.output_chars` 记录累计写入字符数（单调递增），二者共同得出"被截断的前缀长度"。
- 节流：内存累积后按 400ms 或 2000 字符批量 UPDATE；任务结束/失败的 `finally` 必须 `flush()`，否则最后一段丢失。写库失败只 `console.warn`，**不得**因此中断出题任务。
- 读取：`GET /api/admin/jobs/:id/output?offset=N&runId=R`（仅管理员，runId 可省略）返回 `JobOutputDTO`；单次最多 20000 个 Unicode 字符。offset 是相对于累计输出的绝对游标，不随保留窗口截断而停止增长；过旧游标跳到最早保留位置，超前游标回落到累计长度。新增可选响应字段 `runId` 标识当前执行轮次、`startOffset` 标识实际片段起点。客户端原样回传 runId，并丢弃已被截断的本地前缀。轮询间隔仍为 800ms，`output_text` 不进入状态接口。
- 重跑同一任务时清空输出并更换 runId（由任务创建/开始时间构成）；旧轮次游标从当前保留起点重新读取，客户端清空旧轮次内容，避免新旧混合。
- **思考强度**：`provider_settings.thinking_level` ∈ `off|low|medium|high`（默认 `off`），随 `SettingsDTO.thinkingLevel` 读写，`SettingsUpdateRequest.thinkingLevel` 省略即不改。
  - `off`：只发 `chat_template_kwargs: { enable_thinking: false }`（明确关闭思考）。
  - 其它：发 `reasoning_effort: <level>` + `chat_template_kwargs: { enable_thinking: true }`（vLLM/Qwen 系认后者，OpenAI 系认前者）。
  - 上游对未知参数严格校验并返回 400/422 时，**去掉思考参数重试一次**并 warn；同一上游重复失败只 warn 一次，不反复白撞。
  - 思考强度只影响推理开销，不改变提示词与题量；任务开始时读取一次并全程沿用。

## 12. 并行协作流程

1. **类型即契约**：两人都先读 `shared/types/**`；类型与本文冲突时以本文为准，并立刻登记 + 修类型（§1.1）。
2. **开发顺序**（互不阻塞）：
   - 后端：`session` → `settings/models` → `exams` CRUD → `documents` → `questions` → `jobs` → `attempts` → `results/export` → `grade`。
   - 前端：`index` 登录 → `attempt` 作答（可先用空场次错误态跑通）→ `result` → `my-attempts` → `admin` 概览/设置 → 场次编辑 → 汇总/改分。
3. **接口未就绪时**：前端只做三态与骨架渲染，不写入假数据；后端不返回硬编码示例。
4. **联调约定**：任何 DTO 差异先在 `shared/types` 修正并登记，再改两端代码；不要在页面里 `as any` 绕过。
5. **自检命令**：`pnpm typecheck`（提交前必须无错误）；`pnpm dev` 手工走查关键路径。
6. **提交边界**：后端提交只含 `server/**`（+ 新增 ADR）；前端提交只含 `app/**`（+ 可选 `docs/ux-notes.md`）；`shared/**` 变更单独提交并在提交信息里注明「契约变更」。
7. 不主动启动生产构建、不提交/推送、不调用真实模型，除非当次另有授权。

---

## 13. 验收自检清单（映射 design §13.2）

| # | 场景 | 责任方 | 期望 |
| --- | --- | --- | --- |
| 1 | 伪造角色（改 Cookie/加字段） | 后端 | 角色恒由服务端计算；`/api/admin/**` 仍 403 |
| 2 | 用他人 attemptId 访问 | 后端 | `404 NOT_FOUND`，不泄露存在性 |
| 3 | API Key 回传 | 后端 | 任何响应不含 `apiKey`，只有 `hasApiKey` |
| 4 | Base URL 前缀 | 后端 | 保留用户给定路径，只规范化末尾 `/`，不补 `/v1` |
| 5 | 文件解析失败 | 后端+前端 | 具体原因可读，且不占用资料配额 |
| 6 | 抽题数量 | 后端 | 各题型候选 `max(N, min(ceil(N*1.5), 60))`，最终题数等于设定 |
| 7 | 1/3/30/100 题配分 | 后端 | 合计恒为 10000 |
| 8 | 并发发布 | 后端 | 一方成功、另一方 409，不产生重叠场次 |
| 9 | 开始前创建答卷 | 后端 | `409 EXAM_NOT_OPEN` |
| 10 | 刷新续答不重置 | 后端+前端 | `startedAt` 不变，答案与 `version` 保留 |
| 11 | 409 不覆盖 | 前端 | 弹窗选择，服务端版本不被静默覆盖 |
| 12 | 重复交卷 | 后端 | `duplicate:true`，分数不变 |
| 13 | 0 分与无数据 | 前端 | 显示 `0.00` 与「—」而非空/NaN |
| 14 | 恶意答案（越界选项/超长填空/空位不存在） | 后端 | `422 ANSWER_INVALID`，不落库 |
| 15 | immediate / after_exam 边界 | 后端+前端 | 未公开时响应中无答案；到点后可查 |
| 16 | 改分记录 | 后端 | 每次改分有前值/后值/原因/管理员/时间，总分同步 |
| 17 | 跨场隔离 | 后端 | 汇总与导出只含本场数据 |
| 18 | 重启不丢、补齐截止 | 后端 | 进程重启后进行中答卷自动按截止结算 |
| 19 | 移动端可作答 | 前端 | 单列布局、按钮 ≥44px、题号面板可展开 |
| 20 | 数据目录独立 | 后端 | 重建 `.output` 不影响 `data/` |

---

## 14. 已知问题与未决

1. **IPv4 4310 被本机其他进程占用**：Nuxt 监听 `[::1]:4310`，请统一用 `http://localhost:4310`。若目标机器该端口被占，改 `nuxt.config.ts` 的 `devServer.port` 需由骨架所有者执行（属冻结文件）。
2. `node:sqlite` 在 Node 22 标记为 experimental，升级 Node 大版本前需回归；升级方式与原因见 ADR-001。
3. `lodash-unified` 的 Vite 预构建告警来自 `@element-plus/nuxt`，暂不处理。
4. 单进程单 AI 任务的排队上限未做界面提示（design §14.3 已知风险）；管理端只需展示"已有任务执行中"。
5. 长窗口 + `immediate` 策略的泄题风险（design §4.1）为产品已接受项，实现不做额外防护。
6. `.env` 未随仓库提供真实值；首次部署需按 §4.2 配置 `NUXT_ADMIN_NAMES` 与 `NUXT_DATA_DIR`。

---

## 15. 变更记录

| 日期 | 提出方 | 变更点 | 影响面 |
| --- | --- | --- | --- |
| 2026-10-26 | 用户授权实现 | 按 `docs/question-bank-feature.md` 增补题库维护、审核、从场次入库、随机组卷与手动追加、易错统计及资料删除保护；新增 004 迁移和题库管理员接口。管理题目 DTO 增加 bankOrigin（含 deleted），资料库 DTO 增加 questionBankCount，资料库预览追加当前分页定位段 segments | 仅管理员题库与组卷路径；旧接口不新增题库前置条件，考生和评分继续只用场次副本。代码已实现，实际升级与交互由用户试用确认 |
| 2026-10-26 | 用户 | 登录后刷新考试安排，取消登录和首页刷新自动开考，改为点击开始后建卷计时；判断题用绿色勾/红色叉，填空题题面用下划线；新场次默认名称为当天日期加「测试」，默认时区 Asia/Shanghai | 姓名入口、题目显示、新建场次前后端默认值；不迁移已有考试或答案 |
| 2026-10-26 | 用户授权修复 | 修复审查的 14 项：保存队列暂停/失败收尾与后台同步隔离、100 题候选数量、生成编辑锁与重新生成、题型编辑/固定四选项、输出累计游标和轮次、模型错误码重试、服务端公开计时、人工分统计、题目草稿保留及上传事务内校验；删除场次时保留资料库拥有的旧路径原件。JobOutputDTO 追加 runId/startOffset，可选查询 runId | 答题、场次编辑、出题任务、资料与统计；不新增依赖或修改数据库结构 |
| 2026-10-23 | 架构（骨架初始化） | 冻结 v1.0 基线：目录归属、33 个接口、共享类型、错误码表、配分与判分算法、事务与任务约定 | 全部 |
| 2026-10-23 | 用户 | 模型配置改为「API Key 可选」：只校验 `baseUrl` + `modelId`，空 Key 不发送 `Authorization` 头；刷新模型只需 `baseUrl` | `server/ai/client.ts`、`server/services/{settings,generation}.ts`、`app/pages/admin/settings.vue`、`app/components/admin/BlueprintCard.vue` |
| 2026-10-23 | 用户 | **出题任务可靠性修复（排查「卡在 0/4 批」后）**：① `MODEL_REQUEST_TIMEOUT_MS` 120s→300s、`MAX_BATCH_QUESTIONS` 20→6（27B 本地模型单批大会撞超时）；② 单批最多重试 2 次（仅超时/格式漂移/引用校验类错误），引用摘录先按原文回退修复再校验；③ 任务时间戳改为写入时刻取 `Date.now()`，修掉 `finished_at === started_at`；④ `ExamAdminDTO` 新增 `latestJob`，任务失败/中断后界面不再"消失"，且失败时展示错误码与原因 | `shared/constants.ts`、`shared/types/exam.ts`、`server/services/{generation,exams,documents}.ts`、`server/tasks/generation-worker.ts`、`app/components/admin/BlueprintCard.vue` |
| 2026-10-23 | 用户 | **新增资料库（v1.1 增补，见 `docs/library-feature.md` §L1–§L7）**：migration 002 新增 `library_files`/`library_segments` 与 `documents.library_file_id`；新增 5 个接口（列表/上传/预览/删除/从资料库挂载）；`DocumentDTO` 追加 `libraryFileId`；新错误码 `LIBRARY_FILE_IN_USE`、`DOCUMENT_ALREADY_ADDED`；新常量 `MAX_LIBRARY_FILES=100`；场次上传的资料同时入库（单物理文件由资料库持有） | `server/db/**`、`server/services/{documents,library}.ts`、`server/api/admin/library/**`、`server/api/admin/exams/[id]/documents/**`、`shared/types/{library,exam,common}.ts`、`shared/constants.ts`、`app/pages/admin/library.vue`、`app/components/admin/{DocumentsCard,LibraryPickerDialog}.vue`、`app/layouts/admin.vue` |
| 2026-10-26 | 用户 | **出题任务实时输出 + 模型思考强度**：① 新增 `GET /api/admin/jobs/:id/output?offset=N` → `JobOutputDTO`（增量文本，单次 ≤20000 字符，越界回落，`truncated` 表被截断前缀）；② 出题请求走 SSE（`stream:true`），`delta.reasoning`/`delta.reasoning_content` 与 `delta.content` 按到达顺序落 `jobs.output_text`（只留最近 60000 字符，`output_chars` 记累计），400ms/2000 字符节流，`finally` 必 flush；③ `provider_settings.thinking_level` ∈ `off\|low\|medium\|high`（默认 `off`），`high` 映射上游 `xhigh`，上游 400 时去参重试一次并记忆；④ 场次页出题任务下方新增固定最大高度实时输出框（800ms 轮询、可暂停自动滚动、可复制）。详见 §11.8 | migration 003、`server/ai/client.ts`、`server/db/queries/{jobs,settings}.ts`、`server/services/{job-output,generation,settings}.ts`、`server/api/admin/jobs/[id]/output.get.ts`、`shared/{constants,types/admin,types/exam}.ts`、`app/components/admin/{JobOutputPanel,BlueprintCard}.vue`、`app/pages/admin/settings.vue` |
