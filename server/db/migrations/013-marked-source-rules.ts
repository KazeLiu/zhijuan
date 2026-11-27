import type { Migration } from '../types'

export const migration: Migration = {
  version: 13,
  name: 'marked-source-rules',
  sql: 'ALTER TABLE bank_generation_sources ADD COLUMN marked_rules_json TEXT;',
}
