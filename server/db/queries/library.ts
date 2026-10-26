import type { DatabaseSync } from 'node:sqlite'
import type { DocumentFormat } from '../../../shared/types/exam'
import type { LibraryFileDTO, LibraryFileSource } from '../../../shared/types/library'
import { escapeLike } from '../../utils/validate'
import { bankUsageCounts } from './question-bank'
export { escapeLike } from '../../utils/validate'

/** library_files 表行 */
export interface LibraryFileRecord {
  id: string
  originalName: string
  format: DocumentFormat
  byteSize: number
  storagePath: string
  charCount: number
  segmentCount: number
  status: 'parsed' | 'failed'
  errorMessage: string | null
  source: LibraryFileSource
  originExamId: string | null
  createdAt: number
  updatedAt: number
}

/** library_segments 表行：与 document_segments 同构，挂载时整段复制 */
export interface LibrarySegmentRecord {
  id: string
  libraryFileId: string
  seq: number
  locator: string
  startOffset: number
  endOffset: number
  text: string
}

/** 列表行：库条目 + 来源场次标题 + 引用统计 */
export interface LibraryFileListRow {
  file: LibraryFileRecord
  originExamTitle: string | null
  usageCount: number
  usedByExamTitles: string[]
  questionBankCount: number
}

/** 引用该库文件的场次（删除受阻时提示用） */
export interface LibraryReference {
  examId: string
  title: string
}

interface RawLibraryRow {
  id: string
  original_name: string
  format: string
  byte_size: number
  storage_path: string
  char_count: number
  segment_count: number
  status: string
  error_message: string | null
  source: string
  origin_exam_id: string | null
  created_at: number
  updated_at: number
  origin_exam_title?: string | null
}

interface RawLibrarySegmentRow {
  id: string
  library_file_id: string
  seq: number
  locator: string
  start_offset: number
  end_offset: number
  text: string
}

const LIBRARY_COLUMNS = `lf.id, lf.original_name, lf.format, lf.byte_size, lf.storage_path, lf.char_count,
  lf.segment_count, lf.status, lf.error_message, lf.source, lf.origin_exam_id, lf.created_at, lf.updated_at`

function mapLibraryFileRow(row: RawLibraryRow): LibraryFileRecord {
  return {
    id: row.id,
    originalName: row.original_name,
    format: (['pdf', 'docx', 'txt', 'md'] as string[]).includes(row.format)
      ? (row.format as DocumentFormat)
      : 'txt',
    byteSize: Number(row.byte_size),
    storagePath: row.storage_path,
    charCount: Number(row.char_count),
    segmentCount: Number(row.segment_count),
    status: row.status === 'failed' ? 'failed' : 'parsed',
    errorMessage: row.error_message,
    source: row.source === 'exam' ? 'exam' : 'library',
    originExamId: row.origin_exam_id,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  }
}

/** LIKE 通配转义：关键词里的 % 与 _ 按字面量匹配 */
/**
 * 引用统计：一次 documents LEFT JOIN exams 覆盖当前页全部库条目，
 * 同一场次的重复引用只计一次；标题按字典序取前 3 个由调用方截断。
 */
function listUsageByLibraryFileIds(db: DatabaseSync, ids: string[]): Map<string, LibraryReference[]> {
  const result = new Map<string, LibraryReference[]>()
  if (ids.length === 0) return result
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(
      `SELECT d.library_file_id AS library_file_id, e.id AS exam_id, e.title AS exam_title
       FROM documents d
       LEFT JOIN exams e ON e.id = d.exam_id
       WHERE d.library_file_id IN (${placeholders})
       ORDER BY e.title ASC, e.id ASC`,
    )
    .all(...ids) as unknown as Array<{ library_file_id: string; exam_id: string | null; exam_title: string | null }>
  for (const row of rows) {
    if (row.exam_id === null || row.exam_title === null) continue
    const list = result.get(row.library_file_id) ?? []
    if (!list.some((reference) => reference.examId === row.exam_id)) {
      list.push({ examId: row.exam_id, title: row.exam_title })
    }
    result.set(row.library_file_id, list)
  }
  return result
}

export interface LibraryListFilter {
  query?: string
  format?: DocumentFormat
  limit: number
  offset: number
}

/** 资料库列表：created_at DESC, id DESC（§L4.1） */
export function listLibraryFileRows(
  db: DatabaseSync,
  filter: LibraryListFilter,
): { rows: LibraryFileListRow[]; total: number } {
  const where: string[] = []
  const params: Array<string | number> = []
  if (filter.query) {
    where.push("lf.original_name LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(filter.query)}%`)
  }
  if (filter.format) {
    where.push('lf.format = ?')
    params.push(filter.format)
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS total FROM library_files lf ${whereSql}`)
    .get(...params) as { total: number } | undefined
  const files = db
    .prepare(
      `SELECT ${LIBRARY_COLUMNS}, oe.title AS origin_exam_title
       FROM library_files lf
       LEFT JOIN exams oe ON oe.id = lf.origin_exam_id
       ${whereSql}
       ORDER BY lf.created_at DESC, lf.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filter.limit, filter.offset) as unknown as RawLibraryRow[]
  const usage = listUsageByLibraryFileIds(db, files.map((row) => row.id))
  const bankUsage = bankUsageCounts(db, files.map((row) => row.id))
  return {
    total: Number(totalRow?.total ?? 0),
    rows: files.map((row) => {
      const references = usage.get(row.id) ?? []
      return {
        file: mapLibraryFileRow(row),
        originExamTitle: row.origin_exam_title ?? null,
        usageCount: references.length,
        usedByExamTitles: references.slice(0, 3).map((reference) => reference.title),
        questionBankCount: bankUsage.get(row.id) ?? 0,
      }
    }),
  }
}

/** 按 id 读库条目（不存在返回 undefined） */
export function findLibraryFile(db: DatabaseSync, id: string): LibraryFileRecord | undefined {
  const row = db
    .prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_files lf WHERE lf.id = ?`)
    .get(id) as RawLibraryRow | undefined
  return row ? mapLibraryFileRow(row) : undefined
}

/** 批量读库条目（挂载校验用），返回顺序不保证 */
export function findLibraryFilesByIds(db: DatabaseSync, ids: string[]): LibraryFileRecord[] {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  const rows = db
    .prepare(`SELECT ${LIBRARY_COLUMNS} FROM library_files lf WHERE lf.id IN (${placeholders})`)
    .all(...ids) as unknown as RawLibraryRow[]
  return rows.map(mapLibraryFileRow)
}

/** 资料库条目总数（上限校验用，§L4.2） */
export function countLibraryFiles(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM library_files').get() as { total: number } | undefined
  return Number(row?.total ?? 0)
}

/** 读取某库文件的全部定位段（预览与挂载复制用） */
export function listLibrarySegments(db: DatabaseSync, libraryFileId: string): LibrarySegmentRecord[] {
  const rows = db
    .prepare(
      `SELECT id, library_file_id, seq, locator, start_offset, end_offset, text
       FROM library_segments WHERE library_file_id = ? ORDER BY seq ASC`,
    )
    .all(libraryFileId) as unknown as RawLibrarySegmentRow[]
  return rows.map((row) => ({
    id: row.id,
    libraryFileId: row.library_file_id,
    seq: Number(row.seq),
    locator: row.locator,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    text: row.text,
  }))
}

export interface LibraryFileInsert {
  id: string
  originalName: string
  format: DocumentFormat
  byteSize: number
  storagePath: string
  charCount: number
  status?: 'parsed' | 'failed'
  errorMessage?: string | null
  source: LibraryFileSource
  originExamId: string | null
  segments: Array<{ locator: string; startOffset: number; endOffset: number; text: string }>
}

/** 写入资料与其定位段（调用方负责事务与文件落地） */
export function insertLibraryFile(db: DatabaseSync, input: LibraryFileInsert, now: number): void {
  db.prepare(
    `INSERT INTO library_files (id, original_name, format, byte_size, storage_path, char_count, segment_count,
      status, error_message, source, origin_exam_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.originalName,
    input.format,
    input.byteSize,
    input.storagePath,
    input.charCount,
    input.segments.length,
    input.status ?? 'parsed',
    input.errorMessage ?? null,
    input.source,
    input.originExamId,
    now,
    now,
  )
  insertLibrarySegments(db, input.id, input.segments)
}

/** 写入库文件的定位段（id 由「库文件 id-序号」派生，与 document_segments 口径一致） */
export function insertLibrarySegments(
  db: DatabaseSync,
  libraryFileId: string,
  segments: Array<{ locator: string; startOffset: number; endOffset: number; text: string }>,
): void {
  const statement = db.prepare(
    `INSERT INTO library_segments (id, library_file_id, seq, locator, start_offset, end_offset, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  segments.forEach((segment, index) => {
    statement.run(
      `${libraryFileId}-${index + 1}`,
      libraryFileId,
      index + 1,
      segment.locator,
      segment.startOffset,
      segment.endOffset,
      segment.text,
    )
  })
}

/** 删除库条目：除 ON DELETE CASCADE 外也显式删段，避免依赖外键开关 */
export function deleteLibraryFileRow(db: DatabaseSync, libraryFileId: string): void {
  db.prepare('DELETE FROM library_segments WHERE library_file_id = ?').run(libraryFileId)
  db.prepare('DELETE FROM library_files WHERE id = ?').run(libraryFileId)
}

/** 引用该库文件的场次（最多 limit 条，供 409 LIBRARY_FILE_IN_USE 的 details.exams） */
export function listLibraryReferences(db: DatabaseSync, libraryFileId: string, limit: number): LibraryReference[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT e.id AS exam_id, e.title AS title
       FROM documents d JOIN exams e ON e.id = d.exam_id
       WHERE d.library_file_id = ?
       ORDER BY e.title ASC, e.id ASC
       LIMIT ?`,
    )
    .all(libraryFileId, limit) as unknown as Array<{ exam_id: string; title: string }>
  return rows.map((row) => ({ examId: row.exam_id, title: row.title }))
}

/** 本场已挂载的库条目 id（DOCUMENT_ALREADY_ADDED 判定用） */
export function listExamLibraryFileIds(db: DatabaseSync, examId: string): string[] {
  const rows = db
    .prepare('SELECT library_file_id FROM documents WHERE exam_id = ? AND library_file_id IS NOT NULL')
    .all(examId) as unknown as Array<{ library_file_id: string }>
  return rows.map((row) => row.library_file_id)
}

/** 库文件全文（段间以换行连接），用于预览的总字数与切片 */
export function getLibraryFileText(db: DatabaseSync, libraryFileId: string): string {
  return listLibrarySegments(db, libraryFileId)
    .map((segment) => segment.text)
    .join('\n')
}

export function toLibraryFileDTO(row: LibraryFileListRow): LibraryFileDTO {
  return {
    id: row.file.id,
    originalName: row.file.originalName,
    format: row.file.format,
    byteSize: row.file.byteSize,
    charCount: row.file.charCount,
    segmentCount: row.file.segmentCount,
    status: row.file.status,
    errorMessage: row.file.errorMessage,
    source: row.file.source,
    originExamId: row.file.originExamId,
    originExamTitle: row.originExamTitle,
    usageCount: row.usageCount,
    usedByExamTitles: row.usedByExamTitles,
    questionBankCount: row.questionBankCount,
    createdAt: row.file.createdAt,
    updatedAt: row.file.updatedAt,
  }
}
