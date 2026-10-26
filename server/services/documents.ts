import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENTS_PER_EXAM,
  MAX_QUOTE_CHARS,
  MAX_TOTAL_DOCUMENT_CHARS,
  MIN_QUOTE_CHARS,
} from '../../shared/constants'
import type { DocumentFormat } from '../../shared/types/exam'
import type { SourceRef } from '../../shared/types/question'
import type { DocumentPreviewDTO } from '../../shared/types/admin'
import {
  insertDocument,
  countDocuments,
  listDocuments,
  listSegments,
  findDocument,
  findDocumentById,
  findSegment,
  sumDocumentChars,
  deleteDocumentRow,
  toDocumentDTO,
  type DocumentRecord,
} from '../db/queries/documents'
import { findQuestionsReferencingDocument } from '../db/queries/questions'
import { findExam } from '../db/queries/exams'
import { findActiveJob } from '../db/queries/jobs'
import { insertLibraryFile } from '../db/queries/library'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { ensureDataDirs, getStorageRoot, getUploadsDir } from '../utils/paths'

/** DOCX 解压后正文上限，防压缩炸弹（§11.4） */
const MAX_DOCX_CHARS = 200_000
/** TXT/MD 单行超长切分长度 */
const MAX_LINE_CHARS = 1000
/** PDF 判「无可提取文本」阈值（去空白后字符数） */
const MIN_PDF_TEXT_CHARS = 20

export interface ParsedSegment {
  locator: string
  startOffset: number
  endOffset: number
  text: string
}

/** 解析器产出的原始分段（偏移量由 buildSegments 计算） */
interface RawSegment {
  locator: string
  text: string
}

/**
 * 引用命中判定的唯一归一化实现（§11.4）。
 * NFC → 去软连字符 → 统一换行 → 删纯页码行 → 合并空白 → trim。
 */
export function normalizeDocText(input: string): string {
  const unified = input.normalize('NFC').replace(/\u00AD/gu, '').replace(/\r\n?/gu, '\n')
  const lines = unified.split('\n').filter((line) => !isPageArtifactLine(line))
  return lines.join('\n').replace(/\s+/gu, ' ').trim()
}

/** 仅由数字/页码符号构成的行（如 "12"、"第 3 页"、"- 7 -"） */
function isPageArtifactLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return false
  if (/^[\d\s]+$/u.test(trimmed)) return true
  if (/^[-–—\s]*\d+[-–—\s]*$/u.test(trimmed)) return true
  if (/^第\s*\d+\s*页(\s*[/／]\s*共\s*\d+\s*页)?$/u.test(trimmed)) return true
  if (/^\d+\s*[/／]\s*\d+$/u.test(trimmed)) return true
  return false
}

function charLength(value: string): number {
  return Array.from(value).length
}

function splitByLength(line: string, size: number): string[] {
  const chars = Array.from(line)
  const chunks: string[] = []
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(''))
  }
  return chunks.length > 0 ? chunks : ['']
}

function buildSegments(raw: Array<{ locator: string; text: string }>): {
  segments: ParsedSegment[]
  fullText: string
} {
  const segments: ParsedSegment[] = []
  let cursor = 0
  let fullText = ''
  raw.forEach((item, index) => {
    const text = item.text
    if (index > 0) {
      fullText += '\n'
      cursor += 1
    }
    const startOffset = cursor
    fullText += text
    cursor += charLength(text)
    segments.push({ locator: item.locator, startOffset, endOffset: cursor, text })
  })
  return { segments, fullText }
}

async function parsePdf(bytes: Uint8Array): Promise<RawSegment[]> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  let pages: string[] = []
  try {
    const pdf = await getDocumentProxy(bytes)
    const result = await extractText(pdf, { mergePages: false })
    pages = Array.isArray(result.text) ? result.text : [result.text]
  } catch (error) {
    throwApi(
      'FILE_PARSE_FAILED',
      'PDF 解析失败，无法读取正文',
      { reason: `加密 PDF 或文件损坏：${errorText(error)}` },
    )
  }
  const segments = pages.map((text, index) => ({ locator: `p${index + 1}`, text: text.replace(/\r\n?/gu, '\n').trim() }))
  const readable = segments.reduce((sum, segment) => sum + segment.text.replace(/\s+/gu, '').length, 0)
  if (readable < MIN_PDF_TEXT_CHARS) {
    throwApi('FILE_PARSE_FAILED', 'PDF 中没有可提取的文本', {
      reason: '可能是扫描件（图片）或加密 PDF，没有文本层；请换用可复制文字的 PDF，或改用 TXT/MD',
    })
  }
  return segments.filter((segment) => segment.text !== '')
}

async function parseDocx(bytes: Uint8Array): Promise<RawSegment[]> {
  const mammoth = await import('mammoth')
  let raw = ''
  try {
    const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    raw = result.value ?? ''
  } catch (error) {
    throwApi('FILE_PARSE_FAILED', 'DOCX 解析失败，无法读取正文', { reason: errorText(error) })
  }
  if (charLength(raw) > MAX_DOCX_CHARS) {
    throwApi('FILE_PARSE_FAILED', 'DOCX 正文过长，拒绝解析', {
      reason: `解压后正文超过 ${MAX_DOCX_CHARS} 字符，可能存在压缩炸弹`,
    })
  }
  const blocks = raw
    .replace(/\r\n?/gu, '\n')
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block !== '')
  return blocks.map((text, index) => ({ locator: `para${index + 1}`, text }))
}

function parsePlainText(bytes: Uint8Array): RawSegment[] {
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throwApi('FILE_PARSE_FAILED', '文本文件不是有效的 UTF-8 编码', { reason: errorText(error) })
  }
  const lines = text.replace(/\r\n?/gu, '\n').split('\n')
  const segments: RawSegment[] = []
  lines.forEach((line, index) => {
    if (line.trim() === '') return
    if (charLength(line) <= MAX_LINE_CHARS) {
      segments.push({ locator: `line${index + 1}`, text: line })
      return
    }
    // 单行超长：按 1000 字符切分，仍用首个行号定位
    const chunks = splitByLength(line, MAX_LINE_CHARS)
    chunks.forEach((chunk, chunkIndex) => {
      segments.push({ locator: chunkIndex === 0 ? `line${index + 1}` : `line${index + 1}c${chunkIndex + 1}`, text: chunk })
    })
  })
  return segments
}

/** 解析资料正文（§11.4），失败抛 422 FILE_PARSE_FAILED */
export async function parseDocumentBytes(
  format: DocumentFormat,
  bytes: Uint8Array,
): Promise<{ segments: ParsedSegment[]; charCount: number }> {
  let raw: RawSegment[]
  if (format === 'pdf') raw = await parsePdf(bytes)
  else if (format === 'docx') raw = await parseDocx(bytes)
  else raw = parsePlainText(bytes)

  if (raw.length === 0) {
    throwApi('FILE_PARSE_FAILED', '文件中没有可提取的正文', { reason: '解析结果为空，请检查文件内容' })
  }
  const { segments } = buildSegments(raw)
  const charCount = segments.reduce((sum, segment) => sum + charLength(segment.text), 0)
  if (charCount === 0) {
    throwApi('FILE_PARSE_FAILED', '文件中没有可提取的正文', { reason: '解析结果为空，请检查文件内容' })
  }
  return { segments, charCount }
}

/* ------------------------------ 上传与删除 ------------------------------ */

function assertDocumentsEditable(db: DatabaseSync, examId: string): void {
  const exam = findExam(db, examId)
  if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
  if (exam.status !== 'draft') throwApi('EXAM_LOCKED', '已发布场次不能修改资料', { reason: 'published' })
  if (findActiveJob(db, examId)) throwApi('EXAM_HAS_ACTIVE_JOB', '出题任务进行中，暂不能修改资料')
}

function assertDocumentChars(db: DatabaseSync, examId: string, incomingChars: number): void {
  const currentChars = sumDocumentChars(db, examId)
  if (currentChars + incomingChars > MAX_TOTAL_DOCUMENT_CHARS) {
    throwApi('DOCUMENT_CHARS_EXCEEDED', `本场资料合计不能超过 ${MAX_TOTAL_DOCUMENT_CHARS} 字符`, {
      currentChars, incomingChars, limit: MAX_TOTAL_DOCUMENT_CHARS,
    })
  }
}

export interface UploadedFile {
  filename: string
  type?: string
  data: Buffer
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index + 1).toLowerCase() : ''
}

/** 按扩展名 + 文件头判定格式（§11.4），不支持或内容不符抛 422 FILE_TYPE_UNSUPPORTED */
export function detectFormat(filename: string, bytes: Buffer): DocumentFormat {
  const ext = extensionOf(filename)
  const format: DocumentFormat | null =
    ext === 'pdf' || ext === 'docx' || ext === 'txt' || ext === 'md' ? (ext as DocumentFormat) : null
  if (!format) {
    throwApi('FILE_TYPE_UNSUPPORTED', '只支持 PDF、DOCX、TXT、MD 资料', {
      reason: `不支持的文件类型：${ext === '' ? '无扩展名' : `.${ext}`}`,
    })
  }
  if (format === 'pdf') {
    const header = bytes.subarray(0, 5).toString('latin1')
    if (header !== '%PDF-') {
      throwApi('FILE_TYPE_UNSUPPORTED', '文件内容不是有效的 PDF', { reason: '缺少 %PDF- 文件头' })
    }
  } else if (format === 'docx') {
    const isZip = bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
    const hasDocumentXml = bytes.includes(Buffer.from('word/document.xml', 'latin1'))
    if (!isZip || !hasDocumentXml) {
      throwApi('FILE_TYPE_UNSUPPORTED', '文件内容不是有效的 DOCX', {
        reason: '不是 zip 包，或缺少 word/document.xml',
      })
    }
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throwApi('FILE_TYPE_UNSUPPORTED', '文本资料必须是 UTF-8 编码', { reason: '无法按 UTF-8 解码' })
    }
  }
  return format
}

/**
 * 上传资料：校验顺序见 §8.5 20；失败不留库、不留文件。
 * 物理文件写入 uploads/library/ 并由资料库持有（docs/library-feature.md §L3）：
 * 同一事务内先写库条目（source='exam'、origin_exam_id=examId）再写场次资料，
 * 两条元数据共享同一个 storage_path；任一步失败整体回滚并清理已写文件。
 */
export async function uploadDocument(
  db: DatabaseSync,
  examId: string,
  file: UploadedFile,
  now: number,
): Promise<DocumentRecord> {
  if (file.data.length > MAX_DOCUMENT_BYTES) {
    throwApi('FILE_TOO_LARGE', `单份资料不能超过 ${Math.floor(MAX_DOCUMENT_BYTES / 1024 / 1024)}MB`, {
      reason: `当前 ${(file.data.length / 1024 / 1024).toFixed(2)}MB`,
    })
  }
  const format = detectFormat(file.filename, file.data)
  const parsed = await parseDocumentBytes(format, file.data)

  assertDocumentChars(db, examId, parsed.charCount)

  const documentId = randomUUID()
  const libraryFileId = randomUUID()
  const relativePath = `uploads/library/${libraryFileId}.${format}`
  const absolutePath = join(getUploadsDir(), 'library', `${libraryFileId}.${format}`)
  ensureDataDirs()
  await mkdir(join(getUploadsDir(), 'library'), { recursive: true })
  await writeFile(absolutePath, file.data)

  try {
    withTransaction(db, () => {
      // 读取请求、解析文件与磁盘写入均会让出执行权，最终写入前重新检查。
      assertDocumentsEditable(db, examId)
      assertDocumentQuota(countDocuments(db, examId))
      assertDocumentChars(db, examId, parsed.charCount)
      insertLibraryFile(
        db,
        {
          id: libraryFileId,
          originalName: file.filename,
          format,
          byteSize: file.data.length,
          storagePath: relativePath,
          charCount: parsed.charCount,
          source: 'exam',
          originExamId: examId,
          segments: parsed.segments,
        },
        now,
      )
      insertDocument(
        db,
        {
          id: documentId,
          examId,
          libraryFileId,
          originalName: file.filename,
          format,
          byteSize: file.data.length,
          storagePath: relativePath,
          charCount: parsed.charCount,
          segments: parsed.segments,
        },
        now,
      )
    })
  } catch (error) {
    await unlink(absolutePath).catch(() => undefined)
    throw error
  }

  const record = findDocument(db, examId, documentId)
  if (!record) throw new ApiFailure('INTERNAL_ERROR', '资料写入后无法读取')
  return record
}

/**
 * 删除场次资料：只删元数据，不删库条目与物理文件（文件归资料库所有，§L3）。
 * 被题目引用时 409 DOCUMENT_IN_USE。
 */
export async function deleteDocument(db: DatabaseSync, examId: string, documentId: string): Promise<void> {
  const document = withTransaction(db, () => {
    assertDocumentsEditable(db, examId)
    const record = findDocument(db, examId, documentId)
    if (!record) throw new ApiFailure('NOT_FOUND', '资料不存在')
    const questionIds = findQuestionsReferencingDocument(db, examId, documentId)
    if (questionIds.length > 0) {
      throw new ApiFailure('DOCUMENT_IN_USE', '该资料仍被题目引用，无法删除', { questionIds })
    }
    deleteDocumentRow(db, documentId)
    return record
  })
  // 历史数据（library_file_id 为空）的文件没有被资料库接管，仍由场次侧负责清理
  if (document.libraryFileId === null) {
    const indexPath = join(getStorageRoot(), document.storagePath)
    await unlink(indexPath).catch(() => undefined)
  }
}

/** 预览：offset 为全文（按码点）偏移，limit 为本次返回长度 */
export function previewDocument(
  db: DatabaseSync,
  examId: string,
  documentId: string,
  offset: number,
  limit: number,
): DocumentPreviewDTO {
  const document = findDocument(db, examId, documentId)
  if (!document) throw new ApiFailure('NOT_FOUND', '资料不存在')
  const segments = listSegments(db, documentId)
  const fullText = segments.map((segment) => segment.text).join('\n')
  const chars = Array.from(fullText)
  const slice = chars.slice(offset, offset + limit).join('')
  return {
    documentId,
    originalName: document.originalName,
    format: document.format,
    status: document.status,
    errorMessage: document.errorMessage,
    totalChars: chars.length,
    offset,
    limit,
    text: slice,
    truncated: offset + limit < chars.length,
  }
}

/** 读取资料全文（生成任务用） */
export function documentTexts(db: DatabaseSync, documentIds: string[]): Array<{ id: string; name: string; text: string }> {
  const result: Array<{ id: string; name: string; text: string }> = []
  for (const documentId of documentIds) {
    const document = findDocumentById(db, documentId)
    if (!document) continue
    const segments = listSegments(db, documentId)
    result.push({
      id: document.id,
      name: document.originalName,
      text: segments.map((segment) => `[${segment.locator}] ${segment.text}`).join('\n'),
    })
  }
  return result
}

/**
 * 引用校验（§7.4 + §11.4）：资料属于本场、locator 精确命中、quote 归一化后
 * 长度 ≥10 且为该段子串。失败抛 422 QUESTION_SET_INVALID。
 */
export function validateSourceRefs(
  db: DatabaseSync,
  examId: string,
  refs: SourceRef[],
  questionIndex: number,
): void {
  if (refs.length === 0) {
    throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题缺少资料引用`, {
      index: questionIndex,
      reason: 'sourceRefs 为空',
    })
  }
  const documents = listDocuments(db, examId)
  const byId = new Map(documents.map((document) => [document.id, document]))
  for (const ref of refs) {
    const document = byId.get(ref.documentId)
    if (!document) {
      throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题引用了不属于本场次的资料`, {
        index: questionIndex,
        reason: 'documentId 不在本场资料中',
      })
    }
    if (document.status !== 'parsed') {
      throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题引用了未解析成功的资料`, {
        index: questionIndex,
        reason: '资料状态不是 parsed',
      })
    }
    const segment = findSegment(db, ref.documentId, ref.locator)
    if (!segment) {
      throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题的引用定位不存在`, {
        index: questionIndex,
        reason: `locator ${ref.locator} 不属于该资料`,
      })
    }
    const normalizedQuote = normalizeDocText(ref.quote)
    if (charLength(normalizedQuote) < MIN_QUOTE_CHARS) {
      throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题的引用摘录过短`, {
        index: questionIndex,
        reason: `摘录至少 ${MIN_QUOTE_CHARS} 个字符`,
      })
    }
    if (charLength(normalizedQuote) > MAX_QUOTE_CHARS) {
      throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题的引用摘录过长`, {
        index: questionIndex,
        reason: `摘录最多 ${MAX_QUOTE_CHARS} 个字符`,
      })
    }
    if (!normalizeDocText(segment.text).includes(normalizedQuote)) {
      throwApi('QUESTION_SET_INVALID', `第 ${questionIndex + 1} 题的引用摘录未命中资料原文`, {
        index: questionIndex,
        reason: `在 ${ref.locator} 中找不到该摘录`,
      })
    }
  }
}

/** 引用摘录修复结果 */
export interface SourceRefRepairResult {
  refs: SourceRef[]
  /** 被改写的引用条数（0 表示模型给出的摘录本就逐字命中） */
  repaired: number
}

/** 同段回退匹配的最低相似度；跨段回退更严格，避免引用跑到无关段落 */
const RELOCATE_MIN_RATIO = 0.6
const RELOCATE_MIN_RATIO_CROSS_SEGMENT = 0.85

function compactChars(input: string): { text: string; map: number[] } {
  const chars: string[] = []
  const map: number[] = []
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index] as string
    if (/\s/u.test(ch)) continue
    chars.push(ch)
    map.push(index)
  }
  return { text: chars.join(''), map }
}

function bigramsOf(input: string): Set<string> {
  const set = new Set<string>()
  for (let index = 0; index + 1 < input.length; index += 1) set.add(input.slice(index, index + 2))
  return set
}

/** 在 compact 文本中滑窗找出与摘录最相似的等长片段（二元组命中率） */
function bestWindow(compactSegment: string, compactQuote: string): { start: number; ratio: number } {
  const length = compactQuote.length
  if (length === 0 || compactSegment.length < length) return { start: -1, ratio: 0 }
  const quoteBigrams = bigramsOf(compactQuote)
  if (quoteBigrams.size === 0) return { start: -1, ratio: 0 }
  let bestStart = -1
  let bestRatio = 0
  for (let start = 0; start + length <= compactSegment.length; start += 1) {
    const window = compactSegment.slice(start, start + length)
    let hit = 0
    let total = 0
    for (let index = 0; index + 1 < window.length; index += 1) {
      total += 1
      if (quoteBigrams.has(window.slice(index, index + 2))) hit += 1
    }
    const ratio = total === 0 ? 0 : hit / total
    if (ratio > bestRatio) {
      bestRatio = ratio
      bestStart = start
    }
  }
  return { start: bestStart, ratio: bestRatio }
}

/** 在一个段落里定位摘录：逐字命中 → 去空白命中 → 相似度回退，三者都返回资料原文片段 */
function locateQuoteInSegment(
  segmentText: string,
  normalizedQuote: string,
  minRatio: number,
): { quote: string; ratio: number } | null {
  const segmentNorm = normalizeDocText(segmentText)
  if (segmentNorm.includes(normalizedQuote)) return { quote: normalizedQuote, ratio: 1 }
  const compactSegment = compactChars(segmentNorm)
  const compactQuote = compactChars(normalizedQuote)
  if (compactQuote.text.length >= MIN_QUOTE_CHARS) {
    const hit = compactSegment.text.indexOf(compactQuote.text)
    if (hit >= 0) {
      const from = compactSegment.map[hit]
      const to = compactSegment.map[hit + compactQuote.text.length - 1]
      if (from !== undefined && to !== undefined) {
        return { quote: segmentNorm.slice(from, to + 1), ratio: 1 }
      }
    }
    const window = bestWindow(compactSegment.text, compactQuote.text)
    if (window.start >= 0 && window.ratio >= minRatio) {
      const from = compactSegment.map[window.start]
      const to = compactSegment.map[window.start + compactQuote.text.length - 1]
      if (from !== undefined && to !== undefined) {
        const slice = segmentNorm.slice(from, to + 1)
        if (charLength(slice) >= MIN_QUOTE_CHARS) return { quote: slice, ratio: window.ratio }
      }
    }
  }
  return null
}

/**
 * 引用摘录回退修复（§7.4 归一化匹配的工程兜底）：模型偶尔改写、拼接或错标 locator，
 * 这里优先把摘录替换成资料原文片段，再交给 validateSourceRefs 严格校验；
 * 修不动的保持原样，由校验给出可读错误。
 */
export function repairSourceRefs(db: DatabaseSync, examId: string, refs: SourceRef[]): SourceRefRepairResult {
  let repaired = 0
  const repairedRefs: SourceRef[] = []
  for (const ref of refs) {
    const document = findDocument(db, examId, ref.documentId)
    if (!document) {
      repairedRefs.push(ref)
      continue
    }
    const normalizedQuote = normalizeDocText(ref.quote)
    const sameSegment = findSegment(db, ref.documentId, ref.locator)
    if (sameSegment) {
      const hit = locateQuoteInSegment(sameSegment.text, normalizedQuote, RELOCATE_MIN_RATIO)
      if (hit) {
        if (hit.ratio < 1) repaired += 1
        repairedRefs.push({ ...ref, quote: hit.quote })
        continue
      }
    }
    let relocated: { locator: string; quote: string } | null = null
    for (const segment of listSegments(db, ref.documentId)) {
      if (segment.locator === ref.locator) continue
      const hit = locateQuoteInSegment(segment.text, normalizedQuote, RELOCATE_MIN_RATIO_CROSS_SEGMENT)
      if (hit) {
        relocated = { locator: segment.locator, quote: hit.quote }
        break
      }
    }
    if (relocated) {
      repaired += 1
      repairedRefs.push({ ...ref, locator: relocated.locator, quote: relocated.quote })
      continue
    }
    repairedRefs.push(ref)
  }
  return { refs: repairedRefs, repaired }
}

/** 读取已上传资料文件（生成任务不读文件，这里只供排查与未来扩展） */
export async function readDocumentFile(record: DocumentRecord): Promise<Buffer> {
  return readFile(join(getStorageRoot(), record.storagePath))
}

export function formatOfName(name: string): DocumentFormat | null {
  const ext = extensionOf(name)
  return ext === 'pdf' || ext === 'docx' || ext === 'txt' || ext === 'md' ? (ext as DocumentFormat) : null
}

/** 资料数量上限（§8.5 20 前置） */
export function assertDocumentQuota(count: number): void {
  if (count >= MAX_DOCUMENTS_PER_EXAM) {
    throwApi('FILE_LIMIT_EXCEEDED', `每场最多 ${MAX_DOCUMENTS_PER_EXAM} 份资料`, {
      limit: MAX_DOCUMENTS_PER_EXAM,
    })
  }
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, 200)
}

export { toDocumentDTO }
