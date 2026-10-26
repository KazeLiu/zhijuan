# 知卷 v1.1 增补契约：资料库（Library）

> 状态：已确认，作为 `docs/impl-contract.md` 的**追加章节**，编号 `§L1–§L7`。
> 与主契约冲突时以本文为准（仅限资料库相关行为），其余一律沿用主契约。
> 需求来源（用户原话）：『我现在需要加一个资料库的功能，资料库上传文件，然后添加考试的时候，资料可以直接在资料库里面选，这里上传的资料也存一份到资料库里面。』

## §L1 目标与范围

三件事，缺一不可：

1. **独立资料库**：`/admin/library` 页面上传、浏览、搜索、预览、删除文件（pdf/docx/txt/md，与场次资料同一套解析器）。
2. **从资料库选资料**：场次配置页的「资料」卡片里可以点「从资料库添加」，多选后直接挂到本场。
3. **场次上传自动入库**：在某个场次里上传的资料，同时出现在资料库里（标注来源场次）。

不做的事：资料内容编辑、跨用户共享、标签/文件夹（v1.1 不做，保持最小可用）。

## §L2 数据模型（migration 002）

```sql
CREATE TABLE library_files (
  id              TEXT PRIMARY KEY,
  original_name   TEXT NOT NULL,
  format          TEXT NOT NULL,              -- pdf|docx|txt|md
  byte_size       INTEGER NOT NULL,
  storage_path    TEXT NOT NULL,              -- 相对 storageRoot
  char_count      INTEGER NOT NULL,
  segment_count   INTEGER NOT NULL,
  status          TEXT NOT NULL DEFAULT 'parsed',   -- parsed|failed
  error_message   TEXT,
  source          TEXT NOT NULL DEFAULT 'library',  -- library=资料库直传，exam=场次上传归档
  origin_exam_id  TEXT,                       -- source=exam 时记录来源场次（不加外键，场次删除后仍保留）
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX idx_library_files_created ON library_files (created_at DESC);
CREATE INDEX idx_library_files_name ON library_files (original_name);

CREATE TABLE library_segments (
  id              TEXT PRIMARY KEY,
  library_file_id TEXT NOT NULL REFERENCES library_files (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  locator         TEXT NOT NULL,
  start_offset    INTEGER NOT NULL,
  end_offset      INTEGER NOT NULL,
  text            TEXT NOT NULL
);
CREATE UNIQUE INDEX uq_library_segments_locator ON library_segments (library_file_id, locator);

ALTER TABLE documents ADD COLUMN library_file_id TEXT;   -- 指向 library_files.id，可空
CREATE INDEX idx_documents_library ON documents (library_file_id);
```

**回填**：迁移执行时把已有 `documents` 行复制成 `library_files` 条目（`source='exam'`、`origin_exam_id=exam_id`、`id` 用新 UUID，`storage_path` 沿用原值不动文件），`library_segments` 由 `document_segments` 复制，并 `UPDATE documents SET library_file_id=<新 id>`。回填必须在一个事务里完成，且幂等（已存在对应条目则跳过）。

## §L3 物理文件归属

- **一个物理文件只有一份**，由资料库持有：`uploads/library/<libraryFileId>.<ext>`。
- 场次上传资料时：文件写到 `uploads/library/`，同时创建 `library_files`（source=exam）与 `documents` 两条元数据，两者 `storage_path` 相同，`documents.library_file_id` 指向库条目。
- 从资料库挂到场次时：只复制元数据（`documents` + `document_segments`），`storage_path` 共享，不复制文件。
- 历史数据的 `storage_path` 仍是 `uploads/<examId>/<documentId>.<ext>`，不迁移文件位置（只回填元数据）。
- `document_segments` 在挂载时**复制**（不是引用），使既有的 `validateSourceRefs`/`previewDocument` 无需改逻辑。

## §L4 接口（管理员，全部要求已登录 admin）

### §L4.1 `GET /api/admin/library?page=&pageSize=&query=&format=`

- 分页返回 `Paginated<LibraryFileDTO>`；`page` 从 1 起，`pageSize` 默认 20、上限 100（越界用默认）。
- `query`：对 `original_name` 做不区分大小写的模糊匹配，`%`/`_` 必须转义。
- `format`：`pdf|docx|txt|md` 精确过滤，非法值 400 BAD_REQUEST。
- 排序：`created_at DESC, id DESC`。
- 每个条目的 `usageCount`/`usedByExamTitles` 由一次 `documents left join exams` 聚合得到（取前 3 个场次标题即可）。

### §L4.2 `POST /api/admin/library`（multipart，字段名固定 `file`）

- 校验顺序与错误码完全复用主契约 §8.5：单文件、`MAX_DOCUMENT_BYTES`、类型魔术头、解析失败。
- 额外上限：资料库条目数 ≤ `MAX_LIBRARY_FILES`（100），超出 422 `FILE_LIMIT_EXCEEDED`。
- 成功 201 → `LibraryFileDTO`（`source='library'`、`usageCount=0`）。

### §L4.3 `GET /api/admin/library/:fileId/preview?offset=&limit=`

- 复用 `DocumentPreviewDTO`，其中 `documentId` 填**库文件 id**（前端预览组件按 id 使用，不需要知道来源）。
- 默认 `limit = DOCUMENT_PREVIEW_CHARS`，`offset` 默认 0；越界按 0 处理。

### §L4.4 `DELETE /api/admin/library/:fileId`

- 若无任何 `documents.library_file_id` 引用 → 200 `{ data: { ok: true } }`，删元数据并删除物理文件。
- 若被引用 → 409 `LIBRARY_FILE_IN_USE`，`details.exams: [{ id, title }]`（最多 5 条），提示先从场次移除。
- 场次侧删除资料（`DELETE /api/admin/exams/:id/documents/:documentId`）**不删除**库条目与物理文件（库是文件的所有者）。

### §L4.5 `POST /api/admin/exams/:id/documents/from-library`

- 请求 `{ libraryFileIds: string[] }`（1..`MAX_DOCUMENTS_PER_EXAM` 个，去重后处理）。
- 前置校验，顺序固定：
  1. 场次存在且 `status='draft'`，否则 409 `EXAM_LOCKED`；
  2. 存在活动出题任务 → 409 `EXAM_HAS_ACTIVE_JOB`（与上传一致）；
  3. 库文件全部存在，否则 404 `NOT_FOUND`（details.missing: string[]）；
  4. 库文件 `status='parsed'`，否则 422 `VALIDATION_FAILED`（details.fields.libraryFileIds）；
  5. 已挂载过（同场 `documents.library_file_id` 命中）→ 409 `DOCUMENT_ALREADY_ADDED`（details.libraryFileIds）；
  6. 数量上限：`现有数量 + 新增 > MAX_DOCUMENTS_PER_EXAM` → 422 `FILE_LIMIT_EXCEEDED`；
  7. 字符上限：`sumDocumentChars + 新增字符 > MAX_TOTAL_DOCUMENT_CHARS` → 422 `DOCUMENT_CHARS_EXCEEDED`（同现有字段）。
- 全部通过才写入（单事务），201 → `{ added: DocumentDTO[] }`（顺序与请求一致）。
- 成功后**不**触发 `usageCount` 之外的副作用；发布前置检查沿用现有规则。

### §L4.6 既有上传接口的行为变更

`POST /api/admin/exams/:id/documents` 在成功响应之外**额外**做：写库条目（`source='exam'`, `origin_exam_id=examId`）。响应仍是 `DocumentDTO`，但新增字段 `libraryFileId`。若写库失败，整个上传必须回滚（文件也要清理），不得出现"场次有、库里没有"。

## §L5 DTO（`shared/types/library.ts`）

```ts
export type LibraryFileSource = 'library' | 'exam'

export interface LibraryFileDTO {
  id: string
  originalName: string
  format: DocumentFormat
  byteSize: number
  charCount: number
  segmentCount: number
  status: 'parsed' | 'failed'
  errorMessage: string | null
  source: LibraryFileSource
  originExamId: string | null
  originExamTitle: string | null
  usageCount: number
  usedByExamTitles: string[]
  createdAt: EpochMs
  updatedAt: EpochMs
}

export interface LibraryAttachRequest { libraryFileIds: string[] }
export interface LibraryAttachResultDTO { added: DocumentDTO[] }
export interface LibraryDeleteResultDTO { ok: true }
```

`DocumentDTO`（`shared/types/exam.ts`）追加 `libraryFileId: string | null`。

## §L6 新增常量与错误码

`shared/constants.ts`：`MAX_LIBRARY_FILES = 100`。

`shared/types/common.ts` 错误码追加（并入 `API_ERROR_STATUS`）：

| code | HTTP | 何时 |
| --- | --- | --- |
| `LIBRARY_FILE_IN_USE` | 409 | 删除被场次引用的库文件 |
| `DOCUMENT_ALREADY_ADDED` | 409 | 同一库文件已挂在该场 |

## §L7 前端

1. **导航**：管理端侧栏新增「资料库」→ `/admin/library`（放在「考试场次」之后）。
2. **`app/pages/admin/library.vue`**：`PageHeader` + 搜索框（回车/按钮触发）、格式筛选下拉、上传按钮（受 `MAX_LIBRARY_FILES` 与 20MB 限制）、表格列：名称 / 格式 / 大小 / 字数 / 片段数 / 来源（资料库直传 or 来自场次「标题」，可点进该场次）/ 被引用次数 / 创建时间 / 操作（预览、删除）。分页用 `el-pagination`，参数 `page`/`pageSize`。空状态与加载/错误态沿用 `StatePanel`。
3. **`app/components/admin/LibraryPickerDialog.vue`**：`v-model` 控制显隐，内置搜索 + 分页 + 多选表格（`el-table` `@selection-change`），底部显示「已选 N 份 / 本场还可添加 M 份」，确定时 `emit('confirm', ids: string[])`。已在该场的库文件在列表里置灰并标注「已添加」。
4. **`DocumentsCard.vue`**：头部加「从资料库添加」按钮（`locked` 时禁用），点击打开选择器，确认后调 §L4.5，成功刷新；上传成功提示改为「已上传并存入资料库」；列表每行在名称旁显示来源徽标（`libraryFileId` 非空 → 蓝色「库」标签）。
5. 所有请求走 `apiFetch`/`apiUpload`；上传失败用 `describeApiError` 内联展示，不弹全局错误。
