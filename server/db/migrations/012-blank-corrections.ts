import type { Migration } from '../types'

export const migration: Migration = {
  version: 12,
  name: 'blank-corrections',
  sql: `
    CREATE TABLE blank_corrections (
      id TEXT PRIMARY KEY,
      exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
      created_by TEXT NOT NULL,
      applied_by TEXT,
      created_at INTEGER NOT NULL,
      applied_at INTEGER,
      input_json TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      result_json TEXT NOT NULL
    );
    CREATE INDEX idx_blank_corrections_exam ON blank_corrections(exam_id, created_at DESC);
  `,
}
