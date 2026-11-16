import type { Migration } from '../types'
import type { BankGenerationPlan } from '../../services/bank-generation-plan'
import { saveGenerationSource } from '../queries/bank-generation-sources'

export const migration: Migration = {
  version: 11,
  name: 'bank-targeted-generation',
  sql: `
CREATE TABLE bank_generation_sources (
  id TEXT PRIMARY KEY,
  library_file_id TEXT NOT NULL REFERENCES library_files(id) ON DELETE CASCADE,
  location_key TEXT NOT NULL,
  title TEXT NOT NULL,
  knowledge_point TEXT NOT NULL,
  source_group TEXT NOT NULL,
  segments_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(library_file_id, location_key)
);
`,
  run(db) {
    const files = new Set((db.prepare('SELECT id FROM library_files').all() as Array<{ id: string }>).map((row) => row.id))
    const jobs = db.prepare('SELECT id, plan_json, updated_at FROM bank_generation_jobs WHERE plan_json IS NOT NULL ORDER BY updated_at, id').all() as Array<{ id: string; plan_json: string; updated_at: number }>
    for (const job of jobs) {
      const plan = JSON.parse(job.plan_json) as BankGenerationPlan
      for (const source of plan.sources) {
        if (files.has(source.segments[0]!.fileId)) source.id = saveGenerationSource(db, source, job.updated_at)
      }
      db.prepare('UPDATE bank_generation_jobs SET plan_json = ? WHERE id = ?').run(JSON.stringify(plan), job.id)
    }
  },
}
