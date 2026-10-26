import type { Migration } from '../types'

/**
 * 001：首版数据契约（docs/impl-contract.md §7）。
 * - 所有时间列为 UTC 毫秒整数；分值列为整数计分单位（1 单位 = 0.01 分）。
 * - 布尔用 0/1 整数；JSON 结构列存 TEXT。
 * - 表名/列名英文下划线，接口字段驼峰。
 */
export const migration: Migration = {
  version: 1,
  name: 'init',
  sql: `
CREATE TABLE provider_settings (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  base_url    TEXT    NOT NULL DEFAULT '',
  api_key     TEXT,
  model_id    TEXT,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE exams (
  id                  TEXT    PRIMARY KEY,
  title               TEXT    NOT NULL DEFAULT '',
  instructions        TEXT    NOT NULL DEFAULT '',
  status              TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  starts_at           INTEGER NOT NULL,
  ends_at             INTEGER NOT NULL,
  time_zone           TEXT    NOT NULL,
  answer_reveal_policy TEXT   NOT NULL DEFAULT 'immediate' CHECK (answer_reveal_policy IN ('immediate', 'after_exam')),
  blueprint_json      TEXT    NOT NULL DEFAULT '{}',
  version             INTEGER NOT NULL DEFAULT 1,
  published_at        INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL,
  CHECK (ends_at > starts_at)
);
CREATE INDEX idx_exams_status_starts ON exams (status, starts_at);

CREATE TABLE documents (
  id            TEXT    PRIMARY KEY,
  exam_id       TEXT    NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  original_name TEXT    NOT NULL,
  format        TEXT    NOT NULL CHECK (format IN ('pdf', 'docx', 'txt', 'md')),
  byte_size     INTEGER NOT NULL,
  storage_path  TEXT    NOT NULL,
  char_count    INTEGER NOT NULL DEFAULT 0,
  segment_count INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed', 'failed')),
  error_message TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX idx_documents_exam ON documents (exam_id);

CREATE TABLE document_segments (
  id          TEXT    PRIMARY KEY,
  document_id TEXT    NOT NULL REFERENCES documents (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  locator     TEXT    NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset  INTEGER NOT NULL,
  text        TEXT    NOT NULL
);
CREATE UNIQUE INDEX uq_document_segments_locator ON document_segments (document_id, locator);

CREATE TABLE questions (
  id                     TEXT    PRIMARY KEY,
  exam_id                TEXT    NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  position               INTEGER NOT NULL,
  type                   TEXT    NOT NULL CHECK (type IN ('single_choice', 'multiple_choice', 'true_false', 'fill_blank')),
  stem                   TEXT    NOT NULL,
  options_json           TEXT    NOT NULL DEFAULT '[]',
  answer_definition_json TEXT    NOT NULL DEFAULT '{}',
  explanation            TEXT    NOT NULL DEFAULT '',
  source_refs_json       TEXT    NOT NULL DEFAULT '[]',
  max_score_units        INTEGER NOT NULL,
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_questions_exam_position ON questions (exam_id, position);

CREATE TABLE attempts (
  id                TEXT    PRIMARY KEY,
  exam_id           TEXT    NOT NULL REFERENCES exams (id) ON DELETE RESTRICT,
  name              TEXT    NOT NULL,
  name_key          TEXT    NOT NULL,
  status            TEXT    NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'submitted')),
  started_at        INTEGER NOT NULL,
  submitted_at      INTEGER,
  submit_reason     TEXT    CHECK (submit_reason IN ('manual', 'deadline')),
  total_score_units INTEGER,
  version           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE UNIQUE INDEX uq_attempts_exam_name ON attempts (exam_id, name_key);
CREATE INDEX idx_attempts_exam_status ON attempts (exam_id, status, started_at);

CREATE TABLE answers (
  attempt_id           TEXT    NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  question_id          TEXT    NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  answer_json          TEXT,
  auto_score_units     INTEGER NOT NULL DEFAULT 0,
  override_score_units INTEGER,
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);
CREATE INDEX idx_answers_question ON answers (question_id);

CREATE TABLE jobs (
  id             TEXT    PRIMARY KEY,
  type           TEXT    NOT NULL CHECK (type = 'generation'),
  exam_id        TEXT    NOT NULL REFERENCES exams (id) ON DELETE CASCADE,
  status         TEXT    NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  input_version  INTEGER NOT NULL,
  input_json     TEXT    NOT NULL,
  progress_total INTEGER NOT NULL DEFAULT 0,
  progress_done  INTEGER NOT NULL DEFAULT 0,
  model_id       TEXT,
  base_url       TEXT,
  error_code     TEXT,
  error_message  TEXT,
  created_at     INTEGER NOT NULL,
  started_at     INTEGER,
  finished_at    INTEGER
);
CREATE INDEX idx_jobs_exam_created ON jobs (exam_id, created_at);
CREATE INDEX idx_jobs_status ON jobs (status, created_at);
-- 同一草稿只允许一个活动任务（queued/running）
CREATE UNIQUE INDEX uq_jobs_active_exam ON jobs (exam_id) WHERE status IN ('queued', 'running');

CREATE TABLE sessions (
  id         TEXT    PRIMARY KEY,
  name       TEXT    NOT NULL,
  name_key   TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

CREATE TABLE grade_changes (
  id                  TEXT    PRIMARY KEY,
  attempt_id          TEXT    NOT NULL REFERENCES attempts (id) ON DELETE CASCADE,
  question_id         TEXT    NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  previous_score_units INTEGER NOT NULL,
  new_score_units     INTEGER NOT NULL,
  reason              TEXT    NOT NULL,
  admin_name          TEXT    NOT NULL,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_grade_changes_attempt ON grade_changes (attempt_id, created_at);
`,
}
