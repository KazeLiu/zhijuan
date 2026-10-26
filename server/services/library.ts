import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_EXAM,
  MAX_LIBRARY_FILES,
  MAX_TOTAL_DOCUMENT_CHARS,
} from '../../shared/constants'
import type { DocumentFormat } from '../../shared/types/exam'
import type { DocumentPreviewDTO } from '../../shared/types/admin'
import type { LibraryAttachResultDTO, LibraryFileDTO, LibraryFileListDTO } from '../../shared/types/library'
import {
  countLibraryFiles,
  deleteLibraryFileRow,
  findLibraryFile,
  findLibraryFilesByIds,
  getLibraryFileText,
  insertLibraryFile,
  listExamLibraryFileIds,
  listLibraryFileRows,
  listLibraryReferences,
  listLibrarySegments,
  toLibraryFileDTO,
  type LibraryFileListRow,
} from '../db/queries/library'
import {
  countDocuments,
  findDocument,
  insertDocument,
  sumDocumentChars,
  toDocumentDTO,
} from '../db/queries/documents'
import { findExam } from '../db/queries/exams'
import { findActiveJob } from '../db/queries/jobs'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { ensureDataDirs, getStorageRoot, getUploadsDir } from '../utils/paths'
import { detectFormat, parseDocumentBytes, type UploadedFile } from './documents'

/** 删除受阻时在 details.exams 里回显的场次上限（§L4.4） */
const MAX_REFERENCE_EXAMS = 5

export interface LibraryListParams {
  page: number
  pageSize: number
  query?: string
  format?: DocumentFormat
}

/** 资料库条目总数上限（§L4.2）：超出 422 FILE_LIMIT_EXCEEDED */
export function assertLibraryQuota(count: number): void {
  if (count >= MAX_LIBRARY_FILES) {
    throwApi('FILE_LIMIT_EXCEEDED', `资料库最多 ${MAX_LIBRARY_FILES} 个文件`, { limit: MAX_LIBRARY_FILES })
  }
}

/**
 * 上传资料库文件（§L4.2）：校验顺序与场次上传一致（体积 → 类型 → 解析），
 * 物理文件写入 uploads/library/<libraryFileId>.<ext>，失败不留库、不留文件。
 */
export async function uploadLibraryFile(
  db: DatabaseSync,
  file: UploadedFile,
  now: number,
): Promise<LibraryFileDTO> {
  if (file.data.length > MAX_DOCUMENT_BYTES) {
    throwApi('FILE_TOO_LARGE', `单个文件不能超过 ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB`, {
      reason: `当前 ${(file.data.length / 1024 / 1024).toFixed(2)}MB`,
    })
  }
  const format = detectFormat(file.filename, file.data)
  const parsed = await parseDocumentBytes(format, file.data)

  const libraryFileId = randomUUID()
  const relativePath = `uploads/library/${libraryFileId}.${format}`
  const absolutePath = join(getUploadsDir(), 'library', `${libraryFileId}.${format}`)
  ensureDataDirs()
  await mkdir(join(getUploadsDir(), 'library'), { recursive: true })
  await writeFile(absolutePath, file.data)

  try {
    withTransaction(db, () => {
      insertLibraryFile(
        db,
        {
          id: libraryFileId,
          originalName: file.filename,
          format,
          byteSize: file.data.length,
          storagePath: relativePath,
          charCount: parsed.charCount,
          source: 'library',
          originExamId: null,
          segments: parsed.segments,
        },
        now,
      )
    })
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined)
    throw error
  }

  const record = findLibraryFile(db, libraryFileId)
  if (!record) throw new ApiFailure('INTERNAL_ERROR', '资料写入后无法读取')
  return toLibraryFileDTO({
    file: record,
    originExamTitle: null,
    usageCount: 0,
    usedByExamTitles: [],
  })
}

/** 资料库列表（§L4.1）：page 从 1 起，pageSize 由调用方限定在 1..100 */
export function listLibraryFiles(db: DatabaseSync, params: LibraryListParams): LibraryFileListDTO {
  const { rows, total } = listLibraryFileRows(db, {
    query: params.query,
    format: params.format,
    limit: params.pageSize,
    offset: (params.page - 1) * params.pageSize,
  })
  return {
    items: rows.map((row: LibraryFileListRow) => toLibraryFileDTO(row)),
    page: params.page,
    pageSize: params.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
  }
}

/** 资料库预览（§L4.3）：documentId 填库文件 id，offset 按码点计 */
export function previewLibraryFile(
  db: DatabaseSync,
  libraryFileId: string,
  offset: number,
  limit: number,
): DocumentPreviewDTO {
  const file = findLibraryFile(db, libraryFileId)
  if (!file) throw new ApiFailure('NOT_FOUND', '资料不存在')
  const chars = Array.from(getLibraryFileText(db, libraryFileId))
  return {
    documentId: libraryFileId,
    originalName: file.originalName,
    format: file.format,
    status: file.status,
    errorMessage: file.errorMessage,
    totalChars: chars.length,
    offset,
    limit,
    text: chars.slice(offset, offset + limit).join(''),
    truncated: offset + limit < chars.length,
  }
}

/** 删除库文件（§L4.4）：被场次引用 409 LIBRARY_FILE_IN_USE；成功同时删物理文件 */
export async function deleteLibraryFile(db: DatabaseSync, libraryFileId: string): Promise<void> {
  const file = findLibraryFile(db, libraryFileId)
  if (!file) throw new ApiFailure('NOT_FOUND', '资料不存在')
  const references = listLibraryReferences(db, libraryFileId, MAX_REFERENCE_EXAMS)
  if (references.length > 0) {
    throw new ApiFailure('LIBRARY_FILE_IN_USE', '该资料已被场次引用，无法删除', {
      exams: references.map((reference) => ({ id: reference.examId, title: reference.title })),
    })
  }
  withTransaction(db, () => {
    deleteLibraryFileRow(db, libraryFileId)
  })
  const absolutePath = join(getStorageRoot(), file.storagePath)
  await unlink(absolutePath).catch(() => undefined)
}

/**
 * 从资料库添加资料到场次（§L4.5）。校验顺序固定：
 * 1 场次存在且为草稿 → 2 无活动出题任务 → 3 库文件全部存在 → 4 均为 parsed
 * → 5 未重复挂载 → 6 数量上限 → 7 合计字符上限；全通过后单事务写入并复制定位段。
 * 成功不触发额外副作用（不 bump version、不创建任务）。
 */
export function attachLibraryFilesToExam(
  db: DatabaseSync,
  examId: string,
  libraryFileIds: string[],
  now: number,
): LibraryAttachResultDTO {
  const wanted = Array.from(new Set(libraryFileIds))
  const exam = findExam(db, examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '场次不存在')
  if (exam.status !== 'draft') {
    throwApi('EXAM_LOCKED', '已发布的场次不能修改资料', { reason: 'published' })
  }
  if (findActiveJob(db, examId)) {
    throwApi('EXAM_HAS_ACTIVE_JOB', '出题任务进行中，暂不能修改资料')
  }

  const files = findLibraryFilesByIds(db, wanted)
  const existingIds = new Set(files.map((file) => file.id))
  const missing = wanted.filter((id) => !existingIds.has(id))
  if (missing.length > 0) {
    throwApi('NOT_FOUND', '部分资料库文件不存在', { missing })
  }

  const byId = new Map(files.map((file) => [file.id, file]))
  const notParsed = wanted.filter((id) => byId.get(id)?.status !== 'parsed')
  if (notParsed.length > 0) {
    throwApi('VALIDATION_FAILED', '存在未能解析的资料，无法添加', {
      fields: { libraryFileIds: '所选资料必须解析成功后才能使用' },
    })
  }

  const attached = new Set(listExamLibraryFileIds(db, examId))
  const duplicated = wanted.filter((id) => attached.has(id))
  if (duplicated.length > 0) {
    throwApi('DOCUMENT_ALREADY_ADDED', '部分资料已在本次场次中', { libraryFileIds: duplicated })
  }

  const currentCount = countDocuments(db, examId)
  if (currentCount + wanted.length > MAX_DOCUMENTS_PER_EXAM) {
    throwApi('FILE_LIMIT_EXCEEDED', `每场最多 ${MAX_DOCUMENTS_PER_EXAM} 份资料`, {
      limit: MAX_DOCUMENTS_PER_EXAM,
    })
  }

  const currentChars = sumDocumentChars(db, examId)
  const incomingChars = wanted.reduce((sum, id) => sum + (byId.get(id)?.charCount ?? 0), 0)
  if (currentChars + incomingChars > MAX_TOTAL_DOCUMENT_CHARS) {
    throwApi('DOCUMENT_CHARS_EXCEEDED', `本场资料合计不能超过 ${MAX_TOTAL_DOCUMENT_CHARS} 字符`, {
      currentChars,
      incomingChars,
      limit: MAX_TOTAL_DOCUMENT_CHARS,
    })
  }

  const documentIds: string[] = []
  withTransaction(db, () => {
    for (const id of wanted) {
      const file = byId.get(id)
      if (!file) continue
      const documentId = randomUUID()
      const segments = listLibrarySegments(db, id).map((segment) => ({
        locator: segment.locator,
        startOffset: segment.startOffset,
        endOffset: segment.endOffset,
        text: segment.text,
      }))
      insertDocument(
        db,
        {
          id: documentId,
          examId,
          libraryFileId: file.id,
          originalName: file.originalName,
          format: file.format,
          byteSize: file.byteSize,
          storagePath: file.storagePath,
          charCount: file.charCount,
          segments,
        },
        now,
      )
      documentIds.push(documentId)
    }
  })

  const added = documentIds.map((documentId) => {
    const record = findDocument(db, examId, documentId)
    if (!record) throw new ApiFailure('INTERNAL_ERROR', '资料写入后无法读取')
    return toDocumentDTO(record)
  })
  return { added }
}
