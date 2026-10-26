import type { Migration } from '../types'

export const migration: Migration = {
  version: 4,
  name: 'question-bank',
  sql: `
CREATE TABLE question_bank_items (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'disabled')),
  type TEXT NOT NULL CHECK (type IN ('single_choice', 'multiple_choice', 'true_false', 'fill_blank')),
  knowledge_point TEXT NOT NULL,
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'hard')),
  stem TEXT NOT NULL,
  options_json TEXT NOT NULL,
  answer_definition_json TEXT NOT NULL,
  explanation TEXT NOT NULL,
  content_key TEXT NOT NULL UNIQUE,
  origin_exam_id TEXT,
  origin_question_id TEXT,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_bank_filter ON question_bank_items (status, type, knowledge_point, difficulty);
CREATE INDEX idx_bank_updated ON question_bank_items (updated_at DESC, id DESC);
CREATE TABLE question_bank_sources (
  bank_item_id TEXT NOT NULL REFERENCES question_bank_items(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  library_file_id TEXT NOT NULL REFERENCES library_files(id) ON DELETE RESTRICT,
  locator TEXT NOT NULL,
  quote TEXT NOT NULL,
  PRIMARY KEY (bank_item_id, position)
);
CREATE INDEX idx_bank_sources_library ON question_bank_sources(library_file_id);
ALTER TABLE questions ADD COLUMN source_bank_item_id TEXT;
ALTER TABLE questions ADD COLUMN source_bank_item_version INTEGER
  CHECK ((source_bank_item_id IS NULL AND source_bank_item_version IS NULL)
    OR (source_bank_item_id IS NOT NULL AND source_bank_item_version IS NOT NULL));
CREATE INDEX idx_questions_bank_origin ON questions(source_bank_item_id);
`,
}
