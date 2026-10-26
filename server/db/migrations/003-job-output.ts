import type { Migration } from '../types'

/**
 * 003：出题任务实时输出 + 模型思考强度。
 * - jobs.output_text：流式收集的模型原始输出（只保留最近 JOB_OUTPUT_MAX_CHARS 字符，供人工观察）。
 * - provider_settings.thinking_level：off|low|medium|high，默认 off（与原行为一致）。
 * 迁移器已把整段 SQL 包在单事务里，ALTER TABLE 由 schema_migrations 保证只跑一次。
 */
export const migration: Migration = {
  version: 3,
  name: 'job-output-thinking',
  sql: `
ALTER TABLE jobs ADD COLUMN output_text TEXT;
ALTER TABLE jobs ADD COLUMN output_chars INTEGER NOT NULL DEFAULT 0;

ALTER TABLE provider_settings ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off';
`,
}
