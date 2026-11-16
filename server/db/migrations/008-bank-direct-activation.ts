import type { Migration } from '../types'

export const migration: Migration = {
  version: 8,
  name: 'bank-direct-activation',
  sql: `
UPDATE question_bank_items
   SET status = 'active', reviewed_by = NULL, reviewed_at = NULL,
       version = version + 1, updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
 WHERE status = 'draft';
`,
}
