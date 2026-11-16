import type { DatabaseSync } from 'node:sqlite'
import type { Migration } from '../types'

// 存量题干清洗：去掉模型生成的「根据以上资料，」类句首前缀。
// 迁移器把 sql 与 run 包在同一个 BEGIN IMMEDIATE 事务里，这里不要写事务语句，也不要改 PRAGMA。
const PREFIX_PATTERNS: RegExp[] = [
  /^根据(上述|以上|所给|给定)?(资料|材料|原文|上文|文章)[，,、：:]\s*/,
  /^据(资料|材料)[，,、：:]\s*/,
]

/** 去掉句首前缀；裁完为空则保留原文（宁可留脏，不可丢题干）。 */
export function stripStemPrefix(stem: string): string {
  let next = stem
  // 少数题干叠了两层前缀，循环到不再命中为止
  for (let guard = 0; guard < 3; guard += 1) {
    const match = PREFIX_PATTERNS.map(pattern => pattern.exec(next)).find(Boolean)
    if (!match) break
    const trimmed = next.slice(match[0].length)
    if (trimmed.trim().length === 0) break
    next = trimmed
  }
  return next
}

function cleanStemColumn(db: DatabaseSync, table: 'questions' | 'question_bank_items') {
  const rows = db.prepare(`SELECT id, stem FROM ${table}`).all() as Array<{
    id: string
    stem: string
  }>
  const update = db.prepare(`UPDATE ${table} SET stem = ? WHERE id = ?`)
  for (const row of rows) {
    if (typeof row.stem !== 'string') continue
    const next = stripStemPrefix(row.stem)
    if (next !== row.stem) update.run(next, row.id)
  }
}

export const migration: Migration = {
  version: 5,
  name: 'exam-lifecycle',
  sql: `
ALTER TABLE exams ADD COLUMN paused_at INTEGER;
ALTER TABLE exams ADD COLUMN ended_at INTEGER;
`,
  run(db) {
    cleanStemColumn(db, 'questions')
    cleanStemColumn(db, 'question_bank_items')
  },
}
