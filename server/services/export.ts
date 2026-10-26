import ExcelJS from 'exceljs'
import type { CandidateResultRowDTO } from '../../shared/types/admin'
import type { ExamRow } from '../db/queries/exams'
import { formatCompactStamp, formatDateTime } from '../utils/time'

const FORMULA_TRIGGER = /^[=+\-@]/

/** 防公式注入：以 = + - @ 开头的文本前置单引号（§8.6 28） */
function safeText(value: string): string {
  return FORMULA_TRIGGER.test(value) ? `'${value}` : value
}

function sanitizeSheetName(title: string): string {
  const cleaned = title.replace(/[[\]:*?/\\]/g, '').trim()
  const sliced = Array.from(cleaned).slice(0, 31).join('')
  return sliced === '' ? '成绩汇总' : sliced
}

function sanitizeFileName(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|]/g, '-').trim()
  return cleaned === '' ? '考试' : cleaned
}

export interface ResultsWorkbook {
  workbook: ExcelJS.Workbook
  fileName: string
  contentDisposition: string
}

/** 构建场次成绩汇总工作簿（§8.6 28 / §11.6）：由调用方流式写出 */
export function buildResultsWorkbook(exam: ExamRow, rows: CandidateResultRowDTO[], now: number): ResultsWorkbook {
  const workbook = new ExcelJS.Workbook()
  workbook.creator = '知卷'
  const sheet = workbook.addWorksheet(sanitizeSheetName(exam.title), {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  sheet.columns = [
    { header: '姓名', key: 'name', width: 16 },
    { header: '开始时间', key: 'startedAt', width: 22 },
    { header: '交卷时间', key: 'submittedAt', width: 22 },
    { header: '用时（分钟）', key: 'duration', width: 12 },
    { header: '总分', key: 'total', width: 10 },
    { header: '是否及格', key: 'passed', width: 12 },
    { header: '是否人工复核', key: 'manual', width: 12 },
  ]
  const headerRow = sheet.getRow(1)
  headerRow.font = { bold: true }
  headerRow.alignment = { vertical: 'middle' }

  for (const row of rows) {
    const submitted = row.status === 'submitted'
    const durationMinutes =
      row.durationMs === null ? '' : Math.round((row.durationMs / 60000) * 100) / 100
    sheet.addRow({
      name: safeText(row.name),
      startedAt: formatDateTime(row.startedAt, exam.timeZone),
      submittedAt: row.submittedAt === null ? '' : formatDateTime(row.submittedAt, exam.timeZone),
      duration: durationMinutes,
      total: submitted && row.totalScoreUnits !== null ? Number((row.totalScoreUnits / 100).toFixed(2)) : '',
      passed: submitted ? safeText(row.passed === true ? '及格' : '不及格') : '',
      manual: safeText(row.manualReviewed ? '是' : '否'),
    })
  }

  sheet.getColumn('duration').numFmt = '0.00'
  sheet.getColumn('total').numFmt = '0.00'

  const fileName = `${sanitizeFileName(exam.title)}-成绩汇总-${formatCompactStamp(now, exam.timeZone)}.xlsx`
  const asciiFallback = `results-${formatCompactStamp(now, exam.timeZone)}.xlsx`
  const contentDisposition = `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
  return { workbook, fileName, contentDisposition }
}
