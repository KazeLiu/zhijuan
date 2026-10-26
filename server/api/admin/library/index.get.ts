import { DEFAULT_PAGE_SIZE } from '../../../../shared/constants'
import type { DocumentFormat } from '../../../../shared/types/exam'
import { useDb } from '../../../utils/db'
import { ApiFailure, failFrom, ok } from '../../../utils/respond'
import { parsePageValue, queryValue } from '../../../utils/validate'
import { requireAdmin } from '../../../services/session'
import { listLibraryFiles } from '../../../services/library'

/** 资料库列表的 pageSize 上限（docs/library-feature.md §L4.1） */
const MAX_LIBRARY_PAGE_SIZE = 100

const DOCUMENT_FORMATS: DocumentFormat[] = ['pdf', 'docx', 'txt', 'md']

/** pageSize：缺省 20，正整数，越界回落默认值 */
function readPageSize(raw: unknown): number {
  const value = queryValue(raw)
  if (value === undefined || value.trim() === '') return DEFAULT_PAGE_SIZE
  if (!/^\d+$/u.test(value.trim())) throw new ApiFailure('BAD_REQUEST', 'pageSize 必须是正整数')
  const parsed = Number.parseInt(value.trim(), 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_LIBRARY_PAGE_SIZE) return DEFAULT_PAGE_SIZE
  return parsed
}

/** format：缺省不过滤，非法值 400 */
function readFormat(raw: unknown): DocumentFormat | undefined {
  const value = queryValue(raw)
  if (value === undefined || value.trim() === '') return undefined
  const trimmed = value.trim()
  if (!DOCUMENT_FORMATS.includes(trimmed as DocumentFormat)) {
    throw new ApiFailure('BAD_REQUEST', 'format 只接受 pdf、docx、txt、md')
  }
  return trimmed as DocumentFormat
}

/** query：缺省不过滤，空白串按不传处理 */
function readKeyword(raw: unknown): string | undefined {
  const value = queryValue(raw)
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** 资料库列表（§L4.1）：按创建时间倒序，附带引用统计与来源场次标题 */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const db = useDb()
    const query = getQuery(event)
    const page = parsePageValue(query.page)
    const pageSize = readPageSize(query.pageSize)
    const keyword = readKeyword(query.query)
    const format = readFormat(query.format)
    return ok(event, listLibraryFiles(db, { page, pageSize, query: keyword, format }))
  } catch (error) {
    return failFrom(event, error)
  }
})
