# ADR-002: 后台任务用进程内定时器，不引入队列与多实例

## 状态
已接受（2026-10-23）

## 背景
首版有两个必须"自己动"的动作：

1. **截止交卷**：场次到点后，所有 `in_progress` 答卷要按最后保存的答案自动交卷，`submitted_at` 记为该场 `ends_at`（design §6.4）。
2. **AI 出题任务**：`jobs` 表里的 `queued` 任务要被执行，单进程同时只许一个 AI 任务在跑（design §8.4）。

约束：单 Node 进程、Windows 单机、可信内网、不做多实例、不引入 Redis/消息队列。

## 决策
- 两个 `setInterval`（1000ms）由 Nitro 插件在启动时注册：`server/tasks/deadline-sweeper.ts`、`server/tasks/generation-worker.ts`。
- 任务领取用**单条原子 UPDATE ... WHERE status='queued'**，靠 `changes === 1` 判断是否抢到；不做内存锁。
- 关键路径**不依赖**定时器正确性：任何访问过期答卷的接口先对该答卷单独结算（幂等），定时器只是"兜底扫尾"。
- 进程重启时：遗留 `running` 任务标 `failed`（`error_code='INTERRUPTED'`）交人工重试；`queued` 继续执行。

## 备选方案
1. **bullmq + Redis**：多一个必须运维的组件，单机内网无收益。否。
2. **`node-cron` / 外部计划任务**：截止判定需要秒级精度与在线状态，外部调度反而更脆。否。
3. **只在请求时惰性结算（不加定时器）**：如果整场没人访问，答卷会一直停在 `in_progress`，汇总口径（已交卷数、平均分）长期失真。否。
4. **Node `worker_threads` 跑 AI 任务**：AI 调用是 IO 等待，不是 CPU 密集，线程不带来收益，反而让 DB 连接与事务边界复杂化。否。

## 影响
- 变容易：零额外依赖；部署仍是"一个 node 进程 + 一个文件库"。
- 变难/需注意：
  - **只能单实例**。启动第二个进程会重复领取任务、重复结算。若将来要多实例，必须先引入数据库级租约（`jobs.locked_by/locked_at`）或外部队列 —— 这是已知的重构点，已写进契约 §14 风险。
  - 事件循环被长任务阻塞时定时器会漂移；因此 AI 调用有 120s 超时，DB 侧一律短事务。
  - 定时器回调内必须 `try/catch` 全包，单次异常不能让 interval 停摆。
- 可逆性：若后续要换队列，只需替换 `generation-worker` 的领取方式（SQL 条件不变），HTTP 接口与前端轮询模型（1 秒拉 `GET /api/admin/jobs/:id`）保持不变。
