# ADR-001: SQLite 驱动选用 Node 内置 `node:sqlite`

## 状态
已接受（2026-10-23）

## 背景
目标平台是 Windows 内网单机，代码与依赖在目标机安装、构建。设计文档要求单 Node 进程 + 单文件 SQLite。候选驱动两种：

- `better-sqlite3`：生态最成熟、同步 API 友好，但它是原生模块，需要 prebuilt 二进制或本地 C++ 编译工具链（Visual Studio Build Tools + Python）。目标机不一定具备，一次装不上就会把整个交付卡住。
- `node:sqlite`：Node 22.5+ 内置，无需安装、无需编译，API 与 better-sqlite3 接近（`DatabaseSync` + `prepare` + `run/get/all`）。当前 Node 为 v22.19.0，可用。

## 决策
使用 `node:sqlite`（`DatabaseSync`）。依赖清单里不出现任何原生 SQLite 包。

已验证（本机，2026-10-23）：`pnpm install` 零编译，`pnpm dev` 启动即建库，`GET /api/health` 返回 `schemaVersion: 1`。

## 备选方案
1. **better-sqlite3**：性能与文档更好，但把"能否安装"变成环境赌注。否。
2. **`sqlite3` / `node-sqlite3-wasm`**：前者同样原生；后者纯 WASM 但需手动搬 `.wasm` 且无 WAL 语义。否。
3. **换 PostgreSQL**：违反单机单进程约束，运维成本远超收益。否。

## 影响
- 变容易：零编译安装；`.output` 整目录可搬到同平台机器；不需要 postinstall 编译步骤。
- 变难/需注意：
  - Node 22 中 `node:sqlite` 标记 experimental，启动打印 `ExperimentalWarning: SQLite is an experimental feature`（噪声，不影响功能）。升级 Node 大版本前需回归一次。
  - 只使用**位置参数 `?`** 绑定（`stmt.run(a, b)`），不使用命名参数，避免版本间行为差异。
  - 不支持 better-sqlite3 的 `.pragma()` 链式写法，统一用 `db.exec('PRAGMA …')`。
  - 单连接同步 API：同一进程内所有查询串行，长事务会阻塞事件循环 —— 因此禁止在事务内 `await` 模型调用（见契约 §11.1），AI 调用全部在事务外完成。
- 回退路径：`server/utils/db.ts` 是唯一驱动接触面（`useDb` / `withTransaction` 两个导出）。若将来必须换 better-sqlite3，只需替换该文件并删除 `ExperimentalWarning` 相关说明，业务代码不动。
