import type { DatabaseSync } from 'node:sqlite'
import type { ModelRefreshResult, SettingsDTO, ThinkingLevel } from '../../shared/types/admin'
import { THINKING_LEVELS } from '../../shared/types/admin'
import { findProviderSettings, saveProviderSettings, type ProviderSettingsRecord } from '../db/queries/settings'
import { ApiFailure, throwApi } from '../utils/respond'
import { withTransaction } from '../utils/db'
import { FieldErrors, isPlainObject } from '../utils/validate'
import { listModels, normalizeBaseUrl, type ModelConfig } from '../ai/client'

/** 永不返回 apiKey，只给 hasApiKey（§8.4 12） */
export function toSettingsDTO(record: ProviderSettingsRecord): SettingsDTO {
  return {
    baseUrl: record.baseUrl,
    modelId: record.modelId,
    hasApiKey: typeof record.apiKey === 'string' && record.apiKey !== '',
    thinkingLevel: record.thinkingLevel,
    updatedAt: record.updatedAt,
  }
}

export function loadSettings(db: DatabaseSync): SettingsDTO {
  return toSettingsDTO(findProviderSettings(db))
}

const MASKED_KEY = /^\*+$/

function parseThinkingLevel(raw: unknown): ThinkingLevel | null {
  return typeof raw === 'string' && (THINKING_LEVELS as string[]).includes(raw) ? (raw as ThinkingLevel) : null
}

/** 更新设置：apiKey undefined=保持 / null=清除 / 非空=替换（§8.4 13） */
export function updateSettings(db: DatabaseSync, body: Record<string, unknown>, now: number): SettingsDTO {
  const current = findProviderSettings(db)
  const errors = new FieldErrors()

  let baseUrl = current.baseUrl
  if (body.baseUrl !== undefined) {
    if (typeof body.baseUrl !== 'string') {
      errors.add('baseUrl', '接口地址必须是文本')
    } else if (body.baseUrl.trim() === '') {
      baseUrl = ''
    } else {
      try {
        baseUrl = normalizeBaseUrl(body.baseUrl)
      } catch (error) {
        errors.add('baseUrl', error instanceof ApiFailure ? error.message : '接口地址不合法')
      }
    }
  }

  let apiKey = current.apiKey
  if (body.apiKey !== undefined) {
    if (body.apiKey === null) {
      apiKey = null
    } else if (typeof body.apiKey !== 'string') {
      errors.add('apiKey', 'API Key 必须是文本')
    } else if (MASKED_KEY.test(body.apiKey)) {
      throwApi('BAD_REQUEST', 'API Key 不能是全 * 的掩码值')
    } else if (body.apiKey.trim() === '') {
      // 空串视为不修改，避免误清空
      apiKey = current.apiKey
    } else {
      apiKey = body.apiKey.trim()
    }
  }

  let modelId = current.modelId
  if (body.modelId !== undefined) {
    if (body.modelId === null) {
      modelId = null
    } else if (typeof body.modelId !== 'string') {
      errors.add('modelId', '模型 ID 必须是文本')
    } else {
      modelId = body.modelId.trim() === '' ? null : body.modelId.trim()
    }
  }

  let thinkingLevel = current.thinkingLevel
  if (body.thinkingLevel !== undefined) {
    const parsed = parseThinkingLevel(body.thinkingLevel)
    if (parsed === null) {
      errors.add('thinkingLevel', '思考强度只能是 off / low / medium / high')
    } else {
      thinkingLevel = parsed
    }
  }

  errors.throwIfAny()

  withTransaction(db, () => {
    saveProviderSettings(db, { baseUrl, apiKey, modelId, thinkingLevel }, now)
  })
  return toSettingsDTO({ baseUrl, apiKey, modelId, thinkingLevel, updatedAt: now })
}

/** 已保存的模型配置（接口地址与模型为必需项；API Key 可为空，内网模型常不需鉴权） */
export function readModelConfig(db: DatabaseSync): { config: ModelConfig | null; missing: string[] } {
  const record = findProviderSettings(db)
  const missing: string[] = []
  if (record.baseUrl === '') missing.push('baseUrl')
  if (record.modelId === null || record.modelId === '') missing.push('modelId')
  if (missing.length > 0) return { config: null, missing }
  return {
    config: {
      baseUrl: record.baseUrl,
      apiKey: record.apiKey ?? '',
      modelId: record.modelId ?? '',
      thinkingLevel: record.thinkingLevel,
    },
    missing,
  }
}

/** 刷新模型列表，不改变已选模型（§8.4 14） */
export async function refreshModels(db: DatabaseSync): Promise<ModelRefreshResult> {
  const record = findProviderSettings(db)
  const missing: string[] = []
  if (record.baseUrl === '') missing.push('baseUrl')
  if (missing.length > 0) {
    throwApi('MODEL_NOT_CONFIGURED', '请先填写接口地址', { missing })
  }
  const models = await listModels({ baseUrl: record.baseUrl, apiKey: record.apiKey ?? '' })
  return { models, selectedModelId: record.modelId }
}
