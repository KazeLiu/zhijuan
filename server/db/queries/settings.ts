import type { DatabaseSync } from 'node:sqlite'
import type { ThinkingLevel } from '../../../shared/types/admin'

/** provider_settings 单行配置（id 恒为 1） */
export interface ProviderSettingsRecord {
  baseUrl: string
  apiKey: string | null
  modelId: string | null
  /** 思考强度（off|low|medium|high），旧数据默认 off */
  thinkingLevel: ThinkingLevel
  updatedAt: number | null
}

interface RawSettingsRow {
  base_url: string
  api_key: string | null
  model_id: string | null
  thinking_level: string | null
  updated_at: number
}

const THINKING_LEVELS = new Set<string>(['off', 'low', 'medium', 'high'])

function toThinkingLevel(raw: string | null): ThinkingLevel {
  return raw !== null && THINKING_LEVELS.has(raw) ? (raw as ThinkingLevel) : 'off'
}

/** 首次读取不存在时返回空配置，不抛错（§11.7） */
export function findProviderSettings(db: DatabaseSync): ProviderSettingsRecord {
  const row = db
    .prepare('SELECT base_url, api_key, model_id, thinking_level, updated_at FROM provider_settings WHERE id = 1')
    .get() as RawSettingsRow | undefined
  if (!row) return { baseUrl: '', apiKey: null, modelId: null, thinkingLevel: 'off', updatedAt: null }
  return {
    baseUrl: row.base_url,
    apiKey: row.api_key,
    modelId: row.model_id,
    thinkingLevel: toThinkingLevel(row.thinking_level),
    updatedAt: Number(row.updated_at),
  }
}

/** UPSERT id=1 */
export function saveProviderSettings(
  db: DatabaseSync,
  next: { baseUrl: string; apiKey: string | null; modelId: string | null; thinkingLevel: ThinkingLevel },
  now: number,
): void {
  db.prepare(
    `INSERT INTO provider_settings (id, base_url, api_key, model_id, thinking_level, updated_at)
     VALUES (1, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       base_url = excluded.base_url,
       api_key = excluded.api_key,
       model_id = excluded.model_id,
       thinking_level = excluded.thinking_level,
       updated_at = excluded.updated_at`,
  ).run(next.baseUrl, next.apiKey, next.modelId, next.thinkingLevel, now)
}
