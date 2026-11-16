import type { Migration } from '../types'

export const migration: Migration = {
  version: 9,
  name: 'rolling-question-bank',
  sql: `
ALTER TABLE question_bank_items ADD COLUMN source_group TEXT NOT NULL DEFAULT '';
ALTER TABLE questions ADD COLUMN source_bank_group_key TEXT;
UPDATE questions SET source_bank_group_key = 'item:' || source_bank_item_id WHERE source_bank_item_id IS NOT NULL;
UPDATE question_bank_items SET status = 'active' WHERE status = 'draft';
CREATE INDEX idx_bank_source_group ON question_bank_items(source_group);
CREATE INDEX idx_questions_source_group ON questions(source_bank_group_key);
CREATE TABLE bank_generation_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK(status IN ('queued', 'running', 'succeeded', 'failed')),
  input_json TEXT NOT NULL,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL,
  created_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_bank_generation_active ON bank_generation_jobs((1)) WHERE status IN ('queued', 'running');
CREATE TABLE rolling_config (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE rolling_runs (
  date_key TEXT PRIMARY KEY,
  exam_id TEXT REFERENCES exams(id) ON DELETE SET NULL,
  config_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('succeeded', 'failed')),
  error_message TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
`,
}
