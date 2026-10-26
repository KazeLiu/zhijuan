import type { Migration } from '../types'

/**
 * 002：资料库（docs/library-feature.md §L2）。
 * - 新建 library_files / library_segments 与索引，documents 增加 library_file_id。
 * - 回填：已有 documents 逐条复制成库条目（source='exam'、origin_exam_id=exam_id、新 UUID、
 *   storage_path 沿用原值、不动物理文件），document_segments 复制为 library_segments，
 *   最后回写 documents.library_file_id。
 * - 迁移器已把整段 SQL 包在单事务里；回填只处理 library_file_id IS NULL 的行，
 *   重复执行不会重复插入（ALTER TABLE 本身由 schema_migrations 保证只跑一次）。
 */
export const migration: Migration = {
  version: 2,
  name: 'library',
  sql: `
CREATE TABLE library_files (
  id             TEXT    PRIMARY KEY,
  original_name  TEXT    NOT NULL,
  format         TEXT    NOT NULL CHECK (format IN ('pdf', 'docx', 'txt', 'md')),
  byte_size      INTEGER NOT NULL,
  storage_path   TEXT    NOT NULL,
  char_count     INTEGER NOT NULL DEFAULT 0,
  segment_count  INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'parsed' CHECK (status IN ('parsed', 'failed')),
  error_message  TEXT,
  source         TEXT    NOT NULL DEFAULT 'library' CHECK (source IN ('library', 'exam')),
  origin_exam_id TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_library_files_created ON library_files (created_at DESC);
CREATE INDEX idx_library_files_name ON library_files (original_name);

CREATE TABLE library_segments (
  id              TEXT    PRIMARY KEY,
  library_file_id TEXT    NOT NULL REFERENCES library_files (id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  locator         TEXT    NOT NULL,
  start_offset    INTEGER NOT NULL,
  end_offset      INTEGER NOT NULL,
  text            TEXT    NOT NULL
);
CREATE UNIQUE INDEX uq_library_segments_locator ON library_segments (library_file_id, locator);

ALTER TABLE documents ADD COLUMN library_file_id TEXT;
CREATE INDEX idx_documents_library ON documents (library_file_id);

-- 回填开始：历史场次资料复制成库条目，文件归属转移到资料库（storage_path 原样保留）
CREATE TABLE _tmp_library_backfill (
  document_id TEXT PRIMARY KEY,
  library_id  TEXT NOT NULL
);
INSERT INTO _tmp_library_backfill (document_id, library_id)
  SELECT id, lower(
    hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random() % 4) + 1, 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))
  )
  FROM documents WHERE library_file_id IS NULL;

INSERT INTO library_files (id, original_name, format, byte_size, storage_path, char_count, segment_count,
  status, error_message, source, origin_exam_id, created_at, updated_at)
  SELECT m.library_id, d.original_name, d.format, d.byte_size, d.storage_path, d.char_count, d.segment_count,
         d.status, d.error_message, 'exam', d.exam_id, d.created_at, d.created_at
  FROM documents d JOIN _tmp_library_backfill m ON m.document_id = d.id;

INSERT INTO library_segments (id, library_file_id, seq, locator, start_offset, end_offset, text)
  SELECT m.library_id || '-' || s.seq, m.library_id, s.seq, s.locator, s.start_offset, s.end_offset, s.text
  FROM document_segments s JOIN _tmp_library_backfill m ON m.document_id = s.document_id;

UPDATE documents SET library_file_id = (
  SELECT m.library_id FROM _tmp_library_backfill m WHERE m.document_id = documents.id
) WHERE id IN (SELECT document_id FROM _tmp_library_backfill);

DROP TABLE _tmp_library_backfill;
-- 回填结束
`,
}
