import { useDb } from '../../../../../utils/db'
import { ApiFailure, failFrom, ok, throwApi } from '../../../../../utils/respond'
import { readParam } from '../../../../../utils/params'
import { requireAdmin } from '../../../../../services/session'
import { findExam } from '../../../../../db/queries/exams'
import { countDocuments } from '../../../../../db/queries/documents'
import { findActiveJob } from '../../../../../db/queries/jobs'
import { assertDocumentQuota, toDocumentDTO, uploadDocument } from '../../../../../services/documents'

/** 上传资料（§8.5 20）：multipart 字段 file，解析后写库；失败不占配额 */
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    const examId = readParam(event, 'id')
    const db = useDb()
    const exam = findExam(db, examId)
    if (!exam) throw new ApiFailure('NOT_FOUND', '考试场次不存在')
    if (exam.status !== 'draft') throwApi('EXAM_LOCKED', '已发布的考试不能再上传资料', { reason: 'published' })
    if (findActiveJob(db, examId)) throwApi('EXAM_HAS_ACTIVE_JOB', '出题任务进行中，请稍后再上传资料')
    assertDocumentQuota(countDocuments(db, examId))

    const parts = await readMultipartFormData(event)
    const filePart = (parts ?? []).find((part) => part.name === 'file' && typeof part.filename === 'string')
    if (!filePart || !filePart.filename) throw new ApiFailure('BAD_REQUEST', '请选择要上传的文件')

    const document = await uploadDocument(
      db,
      examId,
      { filename: filePart.filename, type: filePart.type, data: filePart.data },
      now,
    )
    return ok(event, toDocumentDTO(document), 201)
  } catch (error) {
    return failFrom(event, error)
  }
})
