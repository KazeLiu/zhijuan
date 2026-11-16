import type { QuestionOption, QuestionType } from '../../../shared/types/question'
import type { Migration } from '../types'
import { bankContentKey } from '../../services/question-bank-stats'
import { regradeSubmittedAttempts } from '../../services/regrading'

export const migration: Migration = {
  version: 7,
  name: 'bank-keys-and-regrading',
  sql: '',
  run(db) {
    const rows = db.prepare('SELECT id, type, stem, options_json, content_key FROM question_bank_items').all() as Array<{
      id: string; type: QuestionType; stem: string; options_json: string; content_key: string
    }>
    const owners = new Map<string, string>()
    const changes: Array<{ id: string; key: string }> = []
    for (const row of rows) {
      const key = bankContentKey({ type: row.type, stem: row.stem, options: JSON.parse(row.options_json) as QuestionOption[] })
      const owner = owners.get(key)
      if (owner) {
        throw new Error(`题库存在相同题干与选项的重复条目：${owner}、${row.id}。未合并或删除数据，请先在旧版本题库中处理重复条目后再升级。`)
      }
      owners.set(key, row.id)
      if (key !== row.content_key) changes.push({ id: row.id, key })
    }
    // 旧键可能正被另一条记录占用，先暂存再统一写回；整个过程由迁移事务保护。
    const update = db.prepare('UPDATE question_bank_items SET content_key = ? WHERE id = ?')
    for (const row of changes) update.run(JSON.stringify(['bank-key-repair', row.id]), row.id)
    for (const row of changes) update.run(row.key, row.id)

    // 修复旧版本暂停改答案后已交卷答卷仍保留旧自动分的问题。
    const exams = db.prepare("SELECT id FROM exams WHERE status = 'published'").all() as Array<{ id: string }>
    const now = Date.now()
    for (const exam of exams) regradeSubmittedAttempts(db, exam.id, now)
  },
}
