import { PassThrough } from 'node:stream'
import { useDb } from '../../../../../utils/db'
import { failFrom } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { requireAdmin } from '../../../../../services/session'
import { buildResultsWorkbook } from '../../../../../services/export'
import { loadResultsForExport } from '../../../../../services/results'

/** 导出成绩汇总（§8.6 28 / §11.6）：同筛选不分页，exceljs 流式写出 xlsx */
export default defineEventHandler((event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    const { exam, rows } = loadResultsForExport(db, examId, getQuery(event), now)
    const { workbook, contentDisposition } = buildResultsWorkbook(exam, rows, now)
    setResponseHeaders(event, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': contentDisposition,
      'Cache-Control': 'no-store',
    })
    const stream = new PassThrough()
    void workbook.xlsx.write(stream).catch((error: unknown) => {
      stream.destroy(error instanceof Error ? error : new Error('成绩汇总导出失败'))
    })
    return sendStream(event, stream)
  } catch (error) {
    return failFrom(event, error)
  }
})
