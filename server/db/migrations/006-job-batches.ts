import type { Migration } from '../types'

// 出题批次持久化（契约 §10.3）：每批成功立即写 questions_json，重试只重跑 pending / failed 批次。
// 迁移器把 sql 包在同一个 BEGIN IMMEDIATE 事务里：这里只 CREATE，不改旧表、不写事务语句、不动 PRAGMA。
export const migration: Migration = {
  version: 6,
  name: 'job-batches',
  sql: `
CREATE TABLE job_batches (
  job_id TEXT NOT NULL,
  batch_index INTEGER NOT NULL,
  type TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  questions_json TEXT,
  error_code TEXT,
  error_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, batch_index),
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX idx_job_batches_status ON job_batches (job_id, status);
`,
}
