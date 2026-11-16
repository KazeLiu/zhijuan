# 场次生命周期与题目编辑改造 · 实施契约（2026-10-27）

本文件是本次改造的唯一契约来源。三位实施者（api-core / bank-ai / web-ui）必须严格按此实现，字段名、状态名、路径、错误码不得自行变更；如遇契约未覆盖的情况，按「最小改动 + 与现有代码风格一致」处理并在完成报告里列出。

## 1. 数据库（migration 005）

`server/db/migrations/005-exam-lifecycle.ts`（编号接在现有 004 之后，先看 `server/db/migrations/` 实际文件名再定号）：

```sql
ALTER TABLE exams ADD COLUMN paused_at INTEGER;
ALTER TABLE exams ADD COLUMN ended_at INTEGER;
```

- `status` 仍只有 `'draft' | 'published'`（不改 CHECK，不做表重建）。
- `paused_at`：非空表示已暂停；`ended_at`：非空表示管理员提前结束。
- 迁移内附加**存量清洗**：把 `questions` 与 `question_bank_items` 的 `stem` 列（注意：`questions.content_json` 里的 `$.stem` 与 `question_bank_items.stem` 列都要处理）开头多余的「根据上述资料」「根据资料」「根据材料」「根据上文」「据资料」等前缀裁掉（只处理**句首**，形如 `^(根据|据)(上述|以上|所给|给定|提供的)?(资料|材料|原文|上文|文章)[，,、：:]\s*`；裁完若为空则保留原文）。

- **迁移机制需要小扩展**：现有 `Migration` 只有 `{ version, name, sql }` 且 runner 直接 `db.exec(sql)`（见 `server/db/types.ts`、`server/utils/db.ts` 的 `runMigrations`）。请给 `Migration` 增加可选 `run?: (db: DatabaseSync) => void`，runner 在 `exec(sql)` 之后、同一事务内调用 `migration.run(db)`；`sql` 仍必填（可为空字符串）。清洗逻辑写进 `run`，用 `db.prepare('SELECT id, content_json FROM questions')` 逐行读取 → 计算 → UPDATE，**同一事务**内完成，不做纯 SQL 的 JSON 改写。

## 2. 阶段与 DTO（shared）

`shared/types/exam.ts`：

```ts
export type ExamPhase = 'draft' | 'upcoming' | 'open' | 'paused' | 'closed'

export interface ExamAdminDTO {
  // …现有字段
  pausedAt: EpochMs | null
  endedAt: EpochMs | null
  /** 实际截止时刻 = endedAt 存在且更早 ? endedAt : endsAt */
  effectiveEndsAt: EpochMs
}

export interface ExamListRowDTO {
  // …现有字段
  pausedAt: EpochMs | null
  endedAt: EpochMs | null
}
```

`shared/utils/exam.ts`（若 phase 计算在别处，同步改；前端 `app/utils/exam.ts` 的标签由 web-ui 补）：

```ts
export function computeExamPhase(
  status: ExamStatus, startsAt: EpochMs, endsAt: EpochMs, now: EpochMs,
  pausedAt: EpochMs | null = null, endedAt: EpochMs | null = null,
): ExamPhase {
  if (status === 'draft') return 'draft'
  const effectiveEnd = endedAt !== null && endedAt < endsAt ? endedAt : endsAt
  if (endedAt !== null || now >= effectiveEnd) return 'closed'
  if (pausedAt !== null) return 'paused'
  if (now < startsAt) return 'upcoming'
  return 'open'
}
```

阶段口径：**已结束优先于已暂停**（暂停中结束 → closed）；暂停中且到点 → closed。

## 3. 行为规则

### 3.1 暂停 / 继续 / 结束（管理端）

| 动作 | 方法/路径 | 允许条件 | 冲突错误码 |
| --- | --- | --- | --- |
| 暂停 | `POST /api/admin/exams/:id/pause` | `status='published'` 且 `ended_at IS NULL` 且 `paused_at IS NULL`（未开始/开放中均可暂停） | `EXAM_NOT_PUBLISHED`、`EXAM_ALREADY_ENDED`、`EXAM_ALREADY_PAUSED` |
| 继续 | `POST /api/admin/exams/:id/resume` | `status='published'` 且 `paused_at IS NOT NULL` 且 `ended_at IS NULL` | `EXAM_NOT_PAUSED`、`EXAM_ALREADY_ENDED` |
| 结束 | `POST /api/admin/exams/:id/end` | `status='published'` 且 `ended_at IS NULL`（**任意阶段**：未开始 / 开放中 / 暂停中都能结束） | `EXAM_ALREADY_ENDED`、`EXAM_NOT_PUBLISHED` |

三个接口都返回 200 + 最新 `ExamAdminDTO`；全部 `version + 1`、`updated_at = now`；写库用 `WHERE ... AND version = ?` 保护并发，失败抛 `VERSION_CONFLICT`。

### 3.2 作答链路（关键口径：提前结束后，进行中的答卷仍能交卷）

- `startAttempt`：指定场次已有本人答卷时先返回续答或已交卷结果；仅创建新答卷时要求 `paused_at IS NULL AND ended_at IS NULL` 且仍在 `[starts_at, ends_at)` 内，否则 `EXAM_NOT_OPEN`。原始 `ends_at` 仍用于截止结算，暂停或提前结束不阻止已有答卷刷新续答。
- `saveAnswer` 仍按**原始 `ends_at`** 判定超时（不能用 effectiveEndsAt），因此暂停期间与提前结束后，进行中的答卷都能继续保存。
- `submitAttempt` 仍按原始 `ends_at` 判定是否截止自动交卷；提前结束后进行中的答卷**可以正常手动提交**，判分与汇总照常计入本场（`attempts` 归属不变，成绩汇总/导出无需改动业务口径）。
- `sweepExpiredAttempts` / `settleAttemptAtDeadline` 保持以原始 `ends_at` 为超时线（提前结束后不立即强制交卷，留给考生交卷）。
- 答案公开：`after_exam` 策略的可揭示时刻改为 `min(endsAt, endedAt ?? endsAt)`（提前结束后即可看答案）；`loadAttemptResult.revealAt` 同步改。
- `loadAttemptDetail`：暂停或已结束的场次，考生仍可打开进行中的答卷继续作答（只要未到原始 ends_at）。
- `GET /api/exams/current`（考生首页）：暂停中的场次不得作为「新考试」推荐；已提前结束的场次按已结束处理。进行中答卷的续答入口走 `GET /api/attempts/:id`，不受影响。

### 3.3 暂停态的编辑权限（用户核心诉求）

| 区域 | 草稿 | 暂停中（published + paused） | 其他（未暂停的已发布 / 已结束） |
| --- | --- | --- | --- |
| 基本信息（标题、须知、开放时间、时区） | 可改 | **可改** | 不可改（`EXAM_LOCKED`） |
| 题目内容（题干、选项、答案、解析、引用） | 可改 | **可改** | 不可改（`EXAM_LOCKED`） |
| 题目结构（增删题、改题型、题量、顺序） | 可改 | **不可改**（`EXAM_STRUCTURE_LOCKED`） | 不可改 |
| 资料（上传/删除/挂载） | 可改 | 不可改 | 不可改 |
| 组卷与出题（blueprint / generate / 从题库组卷） | 可改 | **不可改**（`EXAM_LOCKED`） | 不可改 |

- `PATCH /api/admin/exams/:id`：允许 `status='draft'` 或 `paused_at IS NOT NULL AND ended_at IS NULL`；其余 `EXAM_LOCKED`。时间冲突校验逻辑不变。
- `PUT /api/admin/exams/:id/questions`：允许草稿或暂停态。暂停态下执行**内容级更新**：请求里的题目 id 集合、每题的 `type`、题目总数必须与库内一致，否则 `EXAM_STRUCTURE_LOCKED`；只更新 `stem / options / answerDefinition / explanation / sourceRefs / difficulty`。
- 题目内容改动**同步题库**（口径：这道题被「存入题库」过就一并改）：匹配 `question_bank_items.origin_question_id = questions.id` 的条目（`importExamQuestions` 入库时写入的正是 `origin_exam_id / origin_question_id`），同一事务内把题库条目的 `stem / options_json / answer_definition_json / explanation` 同步为该题最新内容，`version + 1`、`updated_at = now`；`status='disabled'` 或不存在时跳过并计入 `skippedBankItems`。同步成功的条目数放 `syncedBankItems`。
- 同步时内容键随类型、题干与选项更新，实际内容变化后保持启用，不要求审核；无内容变化不递增题库版本。重复内容返回 `QUESTION_BANK_DUPLICATE` 并回滚整个场次保存，不覆盖其他题库题目。
  说明：从题库**复制进**场次的题（`questions.source_bank_item_id` 非空）**不反向改题库**——题库条目可能被多个场次共用，且既有设计是「场次内容不随题库变化」。
- `PUT /api/admin/exams/:id/questions` 响应体 = `ExamAdminDTO` + 两个顶层字段 `syncedBankItems: number`、`skippedBankItems: number`（不改 `ExamAdminDTO` 本身，用交叉类型）。

### 3.4 出题提示词

`server/ai/prompt.ts`：系统提示与输出要求里加一条硬规则——**题干必须是直接陈述的提问句，禁止出现「根据资料/根据材料/根据上述资料/据资料/上文提到」等指向材料的措辞**，示例也要改成不带这些字样的写法（现有示例本身没有该字样，保留即可）。

## 4. 题库入库的知识点默认值（AI 填写）

### 4.1 接口

`POST /api/admin/exams/:id/questions/suggest-knowledge-points`

请求体：`{ "questionIds": ["q1", "q2"] }`（可省略，省略即全卷题目）

响应 200：

```ts
{
  items: Array<{ questionId: string; knowledgePoint: string; source: 'ai' | 'fallback' }>
  degraded: boolean          // true 表示模型未配置/调用失败，用了兜底
  message: string            // degraded 时的中文提示，可直接展示
}
```

实现要点：

- 复用现有 AI 客户端（`server/ai/client.ts`）与模型设置（`server/services/settings.ts`）。模型未配置时返回 `degraded: true`，每题知识点优先沿用同场次或相同资料已有的分类，没有则使用场次标题，`source: 'fallback'`，页面可手动修改。
- 传入提示词的上下文：场次标题、该题完整内容（题干、选项、正确答案、解析），以及完整的已有知识点清单。同场次、同资料使用过的知识点排在前面；模型优先返回 `existingKnowledgePointIndex` 编号，服务端映射为已有名称，只有分类确不适合才新增。每个知识点不超过 `MAX_KNOWLEDGE_POINT_CHARS`，输出严格 JSON。
- 结果必须再过 `normalizeKnowledgePoint` 校验（长度、去空白）；不合格的项回退兜底值。数量与请求的 questionIds 一一对应。
- 单次接口最多处理 50 题；超出只取前 50 并 `degraded` 不变（附 `message` 说明截断）。入库弹窗对所选的最多 100 题按每批 50 题依次请求并合并结果，关闭后忽略旧响应，模型返回不覆盖请求期间的人工填写。

### 4.2 前端交互（ExamToBankDialog）

- 打开对话框即刻发起 suggest 请求，逐题显示 `loading`；返回后**自动填入**每题「主要知识点」，`source='ai'` 的显示「AI 建议」小标签，`source='fallback'` 的显示「默认值」标签。
- 每道题下方的知识点选择器保留，可手工改（现状已有，勿删）；批量「应用到全部」保留但**不再要求先手填**。
- `degraded=true` 时顶部 `el-alert` 提示（`type="warning"`，展示 `message`）。
- 提交按钮的禁用条件改为「存在某题知识点为空」（AI 已填 so 一般直接可提交）。

## 5. 题库入库：全选

`app/components/admin/QuestionsCard.vue` 的题目列表加全选：

- 列表头部放一个 `el-checkbox`（`全选`，支持 `indeterminate`）+ 已选计数「已选 X / N」。
- 勾选作用于「可入库的题目」（现有 `importBlocked` 等既有判定：已有 `sourceBankItemId` 的不参与全选，保持原有逐题禁用规则）。
- 全选/取消全选只影响选择态，不触发任何请求。

## 6. 题目编辑区展示完整内容

`app/components/admin/QuestionsCard.vue` 的题目列表项：在题干下方不再是只显示「答案：…」，而是展示**完整内容**——题型标签、题干、全部选项（标出正确项）、填空空位说明、正确答案、解析。复用 `app/components/QuestionContentView.vue`，并给它新增可选 prop `highlightCorrect?: boolean`（默认 false，管理端传 true 时正确选项加 `.is-correct` 样式与「✓」标记）。考生端用法不变。

## 7. 错误码与文案

新增错误码（沿用 `server/utils/errors.ts` 现有定义方式，HTTP 409）：`EXAM_ALREADY_PAUSED`、`EXAM_NOT_PAUSED`、`EXAM_ALREADY_ENDED`、`EXAM_STRUCTURE_LOCKED`。已有 `EXAM_NOT_PUBLISHED`、`EXAM_LOCKED`、`VERSION_CONFLICT` 复用。

前端中文文案：

- `EXAM_ALREADY_PAUSED` → 場次已暂停
- `EXAM_NOT_PAUSED` → 场次当前不是暂停状态
- `EXAM_ALREADY_ENDED` → 场次已结束
- `EXAM_STRUCTURE_LOCKED` → 暂停状态只能修改题干、选项、答案与解析，不能增删题目或改题型

## 8. 交付与验收

- `pnpm typecheck` 必须 EXIT=0（Lead 终验）。
- 不做破坏性迁移；已有数据必须能启动。
- 所有面向用户的文案用简体中文；代码注释简体中文。
- 完成后在共享任务里报告：改了哪些文件、接口行为、未覆盖项。

## 9. 实施落地与验收记录（2026-10-27 回填）

契约里尚未写死、实现时定型下来的口径，以本节为准：

### 9.1 生命周期

- 迁移 005 只加两列：`exams.paused_at`、`exams.ended_at`（保留 `starts_at`/`ends_at` 原语义，不重建表）。暂停态判定统一为 `paused_at IS NOT NULL AND ended_at IS NULL`。
- **提前结束不改 `ends_at`**：手动作答链路的截止线始终是原始 `ends_at`，因此已开始答卷在提前结束后仍可保存、提交、判分并计入汇总；只有「展示与解析揭示时刻」用 `effectiveEndsAt = min(endsAt, endedAt)`。任何把结束实现成 `ends_at = now` 的改法都会切断这条链路。
- `findOverlappingPublished` 增加 `ended_at IS NULL`：已提前结束的场次不再占用时间窗，`publishExam` 与发布预检的 `time_conflict` 两项自动继承该口径。
- 暂停态 PATCH 允许改 `startsAt`/`endsAt`，与草稿同口径：不做重叠校验（只有 publish 校验）。

### 9.2 题库入库

- `POST /api/admin/exams/:id/questions/to-bank` 需要 `{ expectedExamVersion, items: [{ questionId, knowledgePoint, difficulty? }] }`，`knowledgePoint` 必填；成功响应体是**直接数组**，不是 `{ items }`（客户端按 `Array.isArray(body) ? body : body?.items ?? []` 归一）。
- `difficulty` 可编辑判定在服务端：题库里若已有该 content key 的**其他**条目且难度不同，服务端忽略客户端 difficulty（不报错），保证同 key 多条难度一致。
- `expectedExamVersion` 不一致时直接 409 `VERSION_CONFLICT`，**先于**逐题校验，脚本重试必须带新版本号。

### 9.3 暂停态题目编辑

- `PUT /api/admin/exams/:id/questions` 的暂停态规则：允许改题干/选项/答案/填空/解析/`sourceRefs`；禁止增删题目、禁止改 `type`；`scoreUnits` 保持不变。违规返回 409：结构变化 → `EXAM_STRUCTURE_LOCKED`（message 带题号），出题（`generate`）→ `EXAM_LOCKED`。
- 题库同步匹配 `question_bank_items.origin_question_id`，不反向修改 `source_bank_item_id` 指向的组卷来源。仅内容实际变化时同步类型、题干、选项、答案与解析并更新 `content_key`、版本与更新时间，保持启用；停用条目跳过。重复冲突整次回滚。响应里的 `syncedBankItems` 为实际同步条数。
- 暂停态保存题目后，在同一事务内重算本场已交卷答卷的自动分和总分；原始作答、人工复核分与改分记录保留。未交卷答卷在手动提交或原始截止时间结算时使用最新评分标准。

### 9.4 AI 知识点默认值

- 接口为 `POST /api/admin/exams/:id/questions/suggest-knowledge-points`，请求 `{ questionIds? }`，响应 `{ items: [{ questionId, knowledgePoint, source: 'ai' | 'fallback' }], degraded, message }`。
- 模型未配置或调用失败时返回 `degraded: true`；默认知识点优先使用本场或相同资料已有的知识点，没有则使用场次标题。前端保留人工修改入口。
- 模型配置复用管理端设置及现有 AI 客户端，不新增模型环境变量。

### 9.5 验收证据（Lead 独立执行）

- `pnpm typecheck`：EXIT 0，0 错误。
- 真服务器 + 真 SQLite 端到端冒烟：`node C:\Users\Public\zj-lifecycle-smoke.mjs http://localhost:3010`，**34 项断言全部 PASS**（生命周期建场→发布→暂停→继续→提前结束、暂停态新答卷被拒、结束后进行中答卷可保存可提交且计入汇总满分、AI 建议降级可用、入库、暂停态改题同步题库、改题型/增题/出题被拒、存量题干无「根据资料」前缀）。
- 未覆盖：浏览器人工验收（本机 BrowserSkill 不可用）；前端仅以 typecheck + 代码审阅方式核对。

## 10. 第二轮改造（2026-10-27 下午）

### 10.1 取消时间重叠校验（彻底移除，不保留开关）

- `server/services/exams.ts`：删除 `publishExam` 里的 `EXAM_TIME_CONFLICT` 抛出与 `buildPublishChecklist` 的 `time_conflict` 项；删除暂停态 PATCH 用的 `assertNoTimeConflict`。
- `server/db/queries/exams.ts`：删除 `findOverlappingPublished`（无调用者后一并清理）。
- `shared/types/exam.ts`：预检项 code 联合类型去掉 `'time_conflict'`；前端预检面板不再出现该行。
- 允许同一时段多场同时开放；考生靠「自己选场次」区分（见 10.2）。`sweepExpiredAttempts` / `findLatestClosedExam` / `findOpenExam` 语义不变。
- 同时排查并记录「时间不重叠但日期重叠被拦」的根因到交接口径里（若属前端把 `date` 选择器当 `datetime` 用，需在报告里点名，即使校验已删）。

### 10.2 考生端自选场次

- 新增 `GET /api/exams/available`（考生会话）：返回 `{ items: [{ id, title, startsAt, endsAt, timeZone, phase: 'open'|'upcoming', questionCount, myAttempt: { id, status, submittedAt } | null }] }`。
  - 过滤：`status = 'published' AND ended_at IS NULL AND paused_at IS NULL AND ends_at > now`（已暂停、已结束、已截止一律不出现）。
  - `phase`：`now >= starts_at ? 'open' : 'upcoming'`；**只有 open 可进入**，upcoming 在页面上置灰并显示开始时间。
  - 排序：open 在前按 `starts_at ASC`，upcoming 在后按 `starts_at ASC`。
- `POST /api/attempts/start` 增加必填 `examId`：`startAttempt(db, name, examId, now)` 校验该场次可作答（未暂停、未结束、已在开放窗口、未截止），否则 409 `EXAM_NOT_OPEN`；同一场次仍是一人一次。
- 兼容：不带 `examId` 时按旧规则取当前唯一开放场次（供旧前端/脚本平滑过渡），响应不区分。
- 前端 `app/pages/index.vue`：登录后不再自动取 `/api/exams/current`，改为展示场次卡片列表，点「进入考试」才 start；已交卷场次显示「查看成绩」；空列表显示「暂无进行中的考试」。
- `/api/exams/current` 保留（用于「我的记录」等处），不再作为入口唯一依据。

### 10.3 出题失败批次级重试

- 现状：失败即整卷失败，重试（`POST /api/admin/jobs/:id/retry`）重新跑**全部批次**。
- 改造后：批次结果持久化，重试只跑失败批次。
  - 迁移 006：新增 `job_batches(job_id TEXT NOT NULL, batch_index INTEGER NOT NULL, type TEXT NOT NULL, size INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')), questions_json TEXT, error_code TEXT, error_message TEXT, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY(job_id, batch_index), FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE)`。
  - 执行时每批成功后立即写 `questions_json`（`PreparedQuestion[]`）与 `status='succeeded'`；重试只领取 `status IN ('pending','failed')` 的批次，已成功批次直接复用，不再请求模型。
  - 「某题型有效题不足（`QUESTION_SET_INVALID`）」把该题型所有批次标回 `failed`，使重试能真正补量。
  - 整卷入库语义不变：所有批次成功且逐题型凑够题数后才一次性写 `questions`（仍走 `deleteQuestionsNotIn` + `allocateUnits`）。
  - `POST /api/admin/jobs/:id/retry` 响应增加 `retriedBatches: number`（本次将重跑的批次下标或数量），前端按钮文案改为「重试失败批次」。

### 10.4 已实现事实（2026-10-27 回填）

- 10.1 已按计划落地：`publishExam` 不再抛 `EXAM_TIME_CONFLICT`、`buildPublishChecklist` 只剩 7 项（`title_and_time`/`question_count`/`type_counts`/`question_structure`/`answer_and_refs`/`score_total`/`no_active_job`）、暂停态 PATCH 不再做重叠校验、`findOverlappingPublished` 已删除。`shared/types/common.ts` 里 `EXAM_TIME_CONFLICT` 错误码保留（HTTP 409 映射），仅为向后兼容、当前无抛出点。
- 「日期重叠但时间不重叠被拦」根因（api-core 诊断 + Lead 复核）：服务端的半开区间毫秒比较本身正确，**不是格式化或时区 bug**；真实成因是 `createExam` 的默认窗口为「当天 00:00 → 次日 00:00」，同一天新建的草稿与当天已发布场次默认**整窗重合**，发布时才被判冲突——管理员观感上是「只差日期」。已排除日期选择器 `YYYY-MM-DD HH:mm` 与 `YYYY-MM-DDTHH:mm` 松散解析差异（dayjs 1.11.23 结果一致）。校验整体移除后该症状消失。
- 10.3 落地细节：`RETRYABLE_BATCH_CODES`（`timeout`/`bad_response`/`invalid_response`/`question_set_invalid`）内失败批在同一任务内最多试 `BATCH_MAX_ATTEMPTS=2` 次；上游 5xx 映射的 `UPSTREAM_ERROR` **不在**该集合，单次运行只尝试 1 次，靠 job 级重试兜底——决策理由：硬故障场景批内重试会多等一个完整超时（120s），而 job 级重试已经做到「只重跑失败批次」，用户诉求已满足。

### 10.5 验收记录（Lead 独立执行，2026-10-27）

- `pnpm typecheck`：全仓 exit 0，0 错误。
- 冒烟脚本 `C:\Users\Public\zj-round2-smoke.mjs`（`node … [baseUrl] [dbPath]`），环境 `NUXT_DATA_DIR=D:/code/zhijuan/.tmp/smoke2 pnpm dev --port 3011`：**PASS 34 / FAIL 0**。
  - 10.1：同窗口两场先后 `/publish` 均 200，预检 `codes` 7 项且无 `time_conflict`。
  - 10.2：`/api/exams/available` 返回 2 条、字段完整、open 在 upcoming 前；带 `examId` 开卷 201 且答卷归属所选场次；改场次乙为 `paused` 后 available 不含它、新开卷 409 `EXAM_NOT_OPEN`、进行中答卷仍可 200 保存；`resume` 后回到 available 且 `myAttempt.status=in_progress`；重复开卷 200 同一 `attemptId`；提前 `end` 场次甲后 available 不含它、新开卷 409。
  - 10.3：模型不可达 → job `failed`/`UPSTREAM_ERROR`；`job_batches` 落 1 行 `failed`；`POST /retry` 返回 `retriedBatches=1`；`schema_migrations` = 6。
- 未覆盖：真实模型长跑、浏览器人工验收（`bsk` 未安装）、git 提交（等用户授权）。

## 11. 代码审查修复（2026-10-28）

- 已有答卷的续答检查先于新开卷权限检查；暂停、提前结束后仍可刷新或从「我的记录」进入，原始截止时间结算不变。
- 暂停保存题目时重算已交卷答卷的自动分与总分，保留人工复核分；题库同步更新内容键并清除过期审核信息，冲突回滚整次保存。
- 入库弹窗按每批 50 题获取知识点建议，覆盖最多 100 题；旧请求不回填已关闭的弹窗，也不覆盖请求期间的人工填写。
- 追加 `007-bank-keys-and-regrading` 修复已保存的旧内容键与评分。检测到重复题库内容时回滚并输出冲突条目 ID，由管理员在旧版本处理后升级，不自动合并或删除。
- 核对了相关调用与差异；本轮不新增或运行测试，不启动应用。Docker 构建与运行验收分别记录，生产构建不代替页面和业务验收。

## 12. 题库直接启用与知识点匹配

- 题库新增和从场次入库成功后直接为 `active`；编辑或场次同步保持启用，不再审核。停用题保存后仍停用，重新启用沿用既有 `/approve` 路径，不记录审核信息。
- 迁移 `008-bank-direct-activation` 将旧 `draft` 条目直接启用，已停用条目不变。
- 知识点建议提供完整已有清单，相关来源的分类优先；模型返回已有分类编号，由服务端映射回原名称。只有确无适合分类才新建，页面仍可手工调整。
