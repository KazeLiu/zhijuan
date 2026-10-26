/** 资料库 DTO（docs/library-feature.md §L5） */
import type { EpochMs, Paginated } from './common'
import type { DocumentDTO, DocumentFormat } from './exam'

/** library=资料库直传；exam=场次上传后自动归档 */
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
  /** 被多少个场次资料引用，不包含题库引用。 */
  usageCount: number
  questionBankCount: number
  /** 引用它的场次标题（最多 3 个，供删除受阻时提示） */
  usedByExamTitles: string[]
  createdAt: EpochMs
  updatedAt: EpochMs
}

export type LibraryFileListDTO = Paginated<LibraryFileDTO>

export interface LibraryAttachRequest {
  libraryFileIds: string[]
}

export interface LibraryAttachResultDTO {
  added: DocumentDTO[]
}

export interface LibraryDeleteResultDTO {
  ok: true
}
