import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { GenerationSource, SourceSegment } from '../../services/bank-generation-plan'
import type { MarkedSourceRules } from '../../../shared/types/question-bank'

interface SourceRow {
  id: string
  title: string
  knowledge_point: string
  source_group: string
  segments_json: string
  marked_rules_json: string | null
}

/** 调用方持有事务；同一原文范围沿用来源 ID，任务进度不进入来源目录。 */
export function saveGenerationSource(db: DatabaseSync, source: GenerationSource, now: number): string {
  const location = (source.markedRules ? 'marked:' : '') + JSON.stringify(source.segments.map((segment) => [segment.locator, segment.offset, segment.text]))
  const row = db.prepare(`INSERT INTO bank_generation_sources
    (id, library_file_id, location_key, title, knowledge_point, source_group, segments_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(library_file_id, location_key) DO UPDATE SET title = excluded.title,
      knowledge_point = excluded.knowledge_point, source_group = excluded.source_group,
      segments_json = excluded.segments_json, updated_at = excluded.updated_at RETURNING id`)
    .get(randomUUID(), source.segments[0]!.fileId, location, source.title, source.knowledgePoint,
      source.sourceGroup, JSON.stringify(source.segments), now, now) as { id: string }
  // 迁移 011 回填普通来源时也调用此函数；新增列只在 013 之后的标记模式写入。
  if (source.markedRules) db.prepare('UPDATE bank_generation_sources SET marked_rules_json = ? WHERE id = ?')
    .run(JSON.stringify(source.markedRules), row.id)
  return row.id
}

export function listGenerationSources(db: DatabaseSync): GenerationSource[] {
  const rows = db.prepare(`SELECT s.* FROM bank_generation_sources s
    JOIN library_files f ON f.id = s.library_file_id WHERE f.status = 'parsed'
    ORDER BY s.knowledge_point, s.title, s.id`).all() as unknown as SourceRow[]
  return rows.map((row) => ({ id: row.id, title: row.title, knowledgePoint: row.knowledge_point,
    sourceGroup: row.source_group, segments: JSON.parse(row.segments_json) as SourceSegment[],
    ...(row.marked_rules_json ? { markedRules: JSON.parse(row.marked_rules_json) as MarkedSourceRules } : {}),
    completed: false, generatedCount: 0, createdCount: 0 }))
}
