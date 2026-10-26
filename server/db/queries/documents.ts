import type { DatabaseSync } from 'node:sqlite'
import type { DocumentDTO, DocumentFormat } from '../../../shared/types/exam'

/** documents 表行 */
export interface DocumentRecord {
  id: string
  examId: string
  /** 来源库条目：从资料库挂载或上传后自动入库时非空（docs/library-feature.md §L3） */
  libraryFileId: string | null
  originalName: string
  format: DocumentFormat
  byteSize: number
  storagePath: string
  charCount: number
  segmentCount: number
  status: 'parsed' | 'failed'
  errorMessage: string | null
  createdAt: number
}

/** document_segments 表行：定位段（PDF 页 / DOCX 段 / TXT 行） */
export interface SegmentRecord {
  id: string
  documentId: string
  seq: number
  locator: string
  startOffset: number
  endOffset: number
  text: string
}

interface RawDocumentRow {
  id: string
  exam_id: string
  library_file_id: string | null
  original_name: string
  format: string
  byte_size: number
  storage_path: string
  char_count: number
  segment_count: number
  status: string
  error_message: string | null
  created_at: number
}

interface RawSegmentRow {
  id: string
  document_id: string
  seq: number
  locator: string
  start_offset: number
  end_offset: number
  text: string
}

const DOCUMENT_COLUMNS = `id, exam_id, library_file_id, original_name, format, byte_size, storage_path,
  char_count, segment_count, status, error_message, created_at`

function mapDocumentRow(row: RawDocumentRow): DocumentRecord {
  return {
    id: row.id,
    examId: row.exam_id,
    libraryFileId: row.library_file_id,
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
    createdAt: Number(row.created_at),
  }
}

/** 场次资料列表：created_at ASC, id ASC（上传顺序） */
export function listDocuments(db: DatabaseSync, examId: string): DocumentRecord[] {
  const rows = db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE exam_id = ? ORDER BY created_at ASC, id ASC`)
    .all(examId) as unknown as RawDocumentRow[]
  return rows.map(mapDocumentRow)
}

export function findDocument(db: DatabaseSync, examId: string, documentId: string): DocumentRecord | undefined {
  const row = db
    .prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE exam_id = ? AND id = ?`)
    .get(examId, documentId) as RawDocumentRow | undefined
  return row ? mapDocumentRow(row) : undefined
}

export function findDocumentById(db: DatabaseSync, documentId: string): DocumentRecord | undefined {
  const row = db.prepare(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = ?`).get(documentId) as
    | RawDocumentRow
    | undefined
  return row ? mapDocumentRow(row) : undefined
}

export function listSegments(db: DatabaseSync, documentId: string): SegmentRecord[] {
  const rows = db
    .prepare(
      'SELECT id, document_id, seq, locator, start_offset, end_offset, text FROM document_segments WHERE document_id = ? ORDER BY seq ASC',
    )
    .all(documentId) as unknown as RawSegmentRow[]
  return rows.map((row) => ({
    id: row.id,
    documentId: row.document_id,
    seq: Number(row.seq),
    locator: row.locator,
    startOffset: Number(row.start_offset),
    endOffset: Number(row.end_offset),
    text: row.text,
  }))
}

export function findSegment(db: DatabaseSync, documentId: string, locator: string): SegmentRecord | undefined {
  const row = db
    .prepare(
      'SELECT id, document_id, seq, locator, start_offset, end_offset, text FROM document_segments WHERE document_id = ? AND locator = ?',
    )
    .get(documentId, locator) as RawSegmentRow | undefined
  return row
    ? {
        id: row.id,
        documentId: row.document_id,
        seq: Number(row.seq),
        locator: row.locator,
        startOffset: Number(row.start_offset),
        endOffset: Number(row.end_offset),
        text: row.text,
      }
    : undefined
}

export function sumDocumentChars(db: DatabaseSync, examId: string): number {
  const row = db.prepare('SELECT COALESCE(SUM(char_count), 0) AS total FROM documents WHERE exam_id = ?').get(examId) as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

export function countDocuments(db: DatabaseSync, examId: string): number {
  const row = db.prepare('SELECT COUNT(*) AS total FROM documents WHERE exam_id = ?').get(examId) as
    | { total: number }
    | undefined
  return Number(row?.total ?? 0)
}

export interface DocumentInsert {
  id: string
  examId: string
  /** 来源库条目；场次上传自动入库时必填，历史数据由迁移 002 回填 */
  libraryFileId: string | null
  originalName: string
  format: DocumentFormat
  byteSize: number
  storagePath: string
  charCount: number
  segments: Array<{ locator: string; startOffset: number; endOffset: number; text: string }>
}

/** 写入资料与其定位段（调用方负责事务与文件落地） */
export function insertDocument(db: DatabaseSync, input: DocumentInsert, now: number): void {
  db.prepare(
    `INSERT INTO documents (id, exam_id, library_file_id, original_name, format, byte_size, storage_path,
      char_count, segment_count, status, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', NULL, ?)`,
  ).run(
    input.id,
    input.examId,
    input.libraryFileId,
    input.originalName,
    input.format,
    input.byteSize,
    input.storagePath,
    input.charCount,
    input.segments.length,
    now,
  )
  const statement = db.prepare(
    `INSERT INTO document_segments (id, document_id, seq, locator, start_offset, end_offset, text)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  input.segments.forEach((segment, index) => {
    statement.run(
      `${input.id}-${index + 1}`,
      input.id,
      index + 1,
      segment.locator,
      segment.startOffset,
      segment.endOffset,
      segment.text,
    )
  })
}

export function deleteDocumentRow(db: DatabaseSync, documentId: string): void {
  db.prepare('DELETE FROM documents WHERE id = ?').run(documentId)
}

/** 全文字符数（不含段间分隔符），用于预览的总字数 */
export function getDocumentText(db: DatabaseSync, documentId: string): string {
  return listSegments(db, documentId)
    .map((segment) => segment.text)
    .join('\n')
}

export function toDocumentDTO(record: DocumentRecord): DocumentDTO {
  return {
    id: record.id,
    examId: record.examId,
    libraryFileId: record.libraryFileId,
    originalName: record.originalName,
    format: record.format,
    byteSize: record.byteSize,
    charCount: record.charCount,
    segmentCount: record.segmentCount,
    status: record.status,
    errorMessage: record.errorMessage,
    createdAt: record.createdAt,
  }
}
