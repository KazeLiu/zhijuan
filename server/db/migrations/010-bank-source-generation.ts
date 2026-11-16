import type { Migration } from '../types'

export const migration: Migration = {
  version: 10,
  name: 'bank-source-generation',
  sql: `
ALTER TABLE bank_generation_jobs ADD COLUMN plan_json TEXT;
ALTER TABLE bank_generation_jobs ADD COLUMN run_token TEXT;
`,
}
