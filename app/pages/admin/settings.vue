<script setup lang="ts">
/**
 * 模型设置（契约 §9.2 / §8.4 #12、#13、#14）：
 * Base URL / API Key / 模型 / 思考强度；API Key 只回显「已配置」，清空即清除；可刷新模型列表。
 */
import type { ModelRefreshResult, ModelTestResult, SettingsDTO, SettingsUpdateRequest, ThinkingLevel } from '#shared/types'
import { THINKING_LEVEL_LABELS, THINKING_LEVELS } from '#shared/types'

definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 模型设置' })

const { data, error, pending, refresh } = await useAsyncData<SettingsDTO>(
  'zj-admin-settings',
  () => apiFetch<SettingsDTO>('/api/admin/settings', { silent: true }),
  { server: false },
)

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')

/** 服务端未返回 thinkingLevel 时的兜底值（正常情况下以服务端为准） */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium'

const form = reactive<{
  baseUrl: string
  modelId: string
  apiKey: string
  clearApiKey: boolean
  thinkingLevel: ThinkingLevel
}>({
  baseUrl: '',
  modelId: '',
  apiKey: '',
  clearApiKey: false,
  thinkingLevel: DEFAULT_THINKING_LEVEL,
})

const saving = ref(false)
const refreshingModels = ref(false)
const saveError = ref('')
const saveSuccess = ref('')
const models = ref<string[]>([])
const fieldErrors = ref<Record<string, string>>({})
const connectionTest = reactive({ running: false, result: null as ModelTestResult | null, error: '' })

watch(
  data,
  (value) => {
    if (!value) return
    form.baseUrl = value.baseUrl
    form.modelId = value.modelId ?? ''
    form.apiKey = ''
    form.clearApiKey = false
    form.thinkingLevel = value.thinkingLevel ?? DEFAULT_THINKING_LEVEL
  },
  { immediate: true },
)

const hasApiKey = computed(() => data.value?.hasApiKey === true)
const willClearKey = computed(() => form.clearApiKey)
const keyStateText = computed(() => {
  if (willClearKey.value) return '保存后将清除已配置的 API Key（内网无鉴权的端点可以没有 Key）'
  if (form.apiKey.trim()) return '保存后将替换为新的 API Key'
  if (hasApiKey.value) return '已配置 API Key（出于安全不回显；留空表示保持不变）'
  return '未配置 API Key（可选：内网无鉴权的模型端点无需填写）'
})

const dirty = computed(() => {
  const base = data.value
  if (!base) return false
  return (
    form.baseUrl !== base.baseUrl
    || form.modelId !== (base.modelId ?? '')
    || form.apiKey.trim().length > 0
    || form.clearApiKey
    || form.thinkingLevel !== (base.thinkingLevel ?? DEFAULT_THINKING_LEVEL)
  )
})

const canSave = computed(() => dirty.value && !(form.clearApiKey && form.apiKey.trim().length > 0))
const canTest = computed(() => Boolean(form.baseUrl.trim() && form.modelId.trim()) && !(form.clearApiKey && form.apiKey.trim()))
watch(() => [form.baseUrl, form.modelId, form.apiKey, form.clearApiKey, form.thinkingLevel], () => {
  connectionTest.result = null
  connectionTest.error = ''
})

function settingsPayload(): SettingsUpdateRequest {
  const payload: SettingsUpdateRequest = {
    baseUrl: form.baseUrl.trim(), modelId: form.modelId.trim() || null, thinkingLevel: form.thinkingLevel,
  }
  if (form.apiKey.trim()) payload.apiKey = form.apiKey.trim()
  else if (form.clearApiKey) payload.apiKey = null
  return payload
}

async function testConnection(): Promise<void> {
  if (!canTest.value || connectionTest.running) return
  connectionTest.running = true
  connectionTest.result = null
  connectionTest.error = ''
  fieldErrors.value = {}
  try {
    connectionTest.result = await apiFetch<ModelTestResult>('/api/admin/models/test', {
      method: 'POST', body: settingsPayload(), silent: true,
    })
  } catch (cause) {
    fieldErrors.value = readFieldErrors(cause)
    connectionTest.error = describeApiError(cause, '连接测试失败')
  } finally { connectionTest.running = false }
}

async function save(): Promise<void> {
  saveError.value = ''
  saveSuccess.value = ''
  fieldErrors.value = {}
  // Base URL 是唯一必填项；API Key 可选，内网无鉴权的模型端点可留空
  if (!form.baseUrl.trim()) {
    fieldErrors.value = { baseUrl: '请填写 Base URL，例如 http://192.168.1.10:8000/v1' }
    return
  }
  saving.value = true
  try {
    const updated = await apiFetch<SettingsDTO>('/api/admin/settings', {
      method: 'PUT',
      body: settingsPayload(),
      silent: true,
    })
    data.value = updated
    form.apiKey = ''
    form.clearApiKey = false
    saveSuccess.value = '设置已保存'
    ElMessage.success('设置已保存')
  } catch (error) {
    fieldErrors.value = readFieldErrors(error)
    saveError.value = describeApiError(error, '保存设置失败')
  } finally {
    saving.value = false
  }
}

async function refreshModels(): Promise<void> {
  refreshingModels.value = true
  saveError.value = ''
  try {
    const result = await apiFetch<ModelRefreshResult>('/api/admin/models/refresh', {
      method: 'POST',
      silent: true,
    })
    models.value = result.models
    if (!form.modelId && result.selectedModelId) form.modelId = result.selectedModelId
    ElMessage.success(`已获取 ${result.models.length} 个模型`)
    if (result.models.length === 0) {
      saveError.value = '上游没有返回任何模型，请确认 Base URL 指向兼容 /models 的端点'
    }
  } catch (error) {
    saveError.value = describeApiError(error, '刷新模型列表失败')
  } finally {
    refreshingModels.value = false
  }
}
</script>

<template>
  <section class="settings">
    <PageHeader title="模型设置" description="AI 出题使用 OpenAI 兼容的 /chat/completions 接口；填 Base URL 与模型即可，API Key 可选（内网无鉴权的模型端点留空），Key 只保存在服务端。可设置思考强度。">
      <template #actions>
        <el-button :loading="pending" :disabled="saving || connectionTest.running" @click="refresh()">重新读取</el-button>
      </template>
    </PageHeader>

    <StatePanel
      v-if="error"
      :state="forbidden ? 'forbidden' : 'error'"
      :title="forbidden ? '需要管理员权限' : '读取设置失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : undefined"
      :action-text="forbidden ? '重新登录' : ''"
      @retry="refresh()"
    />

    <StatePanel v-else-if="pending && !data" state="loading" title="正在读取设置…" :loading-rows="6" />

    <el-card v-else-if="data" shadow="never" class="settings__card">
      <el-form label-position="top" class="settings__form" :disabled="saving || refreshingModels || connectionTest.running" @submit.prevent="save">
        <el-form-item label="Base URL（OpenAI 兼容端点根地址）" :error="fieldErrors.baseUrl">
          <el-input v-model="form.baseUrl" placeholder="https://api.example.com/v1" />
          <p class="zj-muted settings__hint">出题请求会发往 <code>{baseUrl}/chat/completions</code>，只接受 http/https。</p>
        </el-form-item>

        <el-form-item label="API Key（可选）" :error="fieldErrors.apiKey">
          <el-input
            v-model="form.apiKey"
            type="password"
            show-password
            :disabled="form.clearApiKey"
            placeholder="留空表示保持现有 Key 不变；无鉴权的内网端点无需填写"
          />
          <div class="settings__key-row">
            <span class="zj-muted settings__key-state">{{ keyStateText }}</span>
            <el-checkbox v-if="hasApiKey" v-model="form.clearApiKey" :disabled="!!form.apiKey.trim()">
              清除已配置的 API Key
            </el-checkbox>
          </div>
        </el-form-item>

        <el-form-item label="模型" :error="fieldErrors.modelId">
          <div class="settings__model-row">
            <el-select
              v-if="models.length"
              v-model="form.modelId"
              filterable
              allow-create
              default-first-option
              placeholder="选择或输入模型 ID"
              class="settings__model-select"
            >
              <el-option v-for="model in models" :key="model" :label="model" :value="model" />
            </el-select>
            <el-input v-else v-model="form.modelId" placeholder="例如 gpt-4o-mini / qwen-plus" class="settings__model-select" />
            <el-button :loading="refreshingModels" @click="refreshModels">刷新模型列表</el-button>
          </div>
          <p class="zj-muted settings__hint">
            刷新只读取上游模型清单，不会自动更换当前已选模型。当前模型：
            {{ data?.modelId || '未选择' }}
          </p>
        </el-form-item>

        <el-form-item label="思考强度">
          <el-select v-model="form.thinkingLevel" class="settings__thinking-select">
            <el-option
              v-for="level in THINKING_LEVELS"
              :key="level"
              :label="THINKING_LEVEL_LABELS[level]"
              :value="level"
            />
          </el-select>
          <p class="zj-muted settings__hint">强度越高，模型的推理过程越充分，但出题耗时也越长。</p>
        </el-form-item>

        <el-alert v-if="saveError" type="error" :closable="false" show-icon :title="saveError" class="settings__alert" />
        <el-alert v-if="saveSuccess" type="success" :closable="false" show-icon :title="saveSuccess" class="settings__alert" />

        <div class="settings__actions">
          <el-button type="primary" :loading="saving" :disabled="!canSave" @click="save">保存设置</el-button>
          <el-button :loading="connectionTest.running" :disabled="!canTest" @click="testConnection">测试连接</el-button>
          <span class="zj-muted settings__hint">
            {{ dirty ? '测试使用当前填写配置，不保存。' : `最近更新：${data.updatedAt ? formatDateTimeSeconds(data.updatedAt, browserTimeZone()) : '尚未保存过'}` }}
          </span>
        </div>
        <el-alert v-if="connectionTest.error" type="error" :closable="false" show-icon :title="connectionTest.error" class="settings__test-result" />
        <el-alert v-if="connectionTest.result" type="success" :closable="false" show-icon :title="`连接成功，模型 ${connectionTest.result.modelId} 已响应，耗时 ${(connectionTest.result.durationMs / 1000).toFixed(2)} 秒`" class="settings__test-result" />

        <p class="zj-muted settings__note">
          思考强度只影响出题请求的推理开销，「关闭」最快；部分模型/端点不支持该参数，服务端会自动回退。
        </p>
      </el-form>
    </el-card>
  </section>
</template>

<style scoped>
.settings__card {
  max-width: 760px;
}

.settings__hint {
  margin: 6px 0 0;
  font-size: 13px;
}

.settings__key-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  margin-top: 8px;
}

.settings__key-state {
  font-size: 13px;
}

.settings__model-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  width: 100%;
}

.settings__model-select {
  flex: 1 1 240px;
  min-width: 200px;
}

.settings__alert {
  margin-bottom: 12px;
}

.settings__thinking-select {
  width: 100%;
  max-width: 320px;
}

.settings__note {
  margin: 12px 0 0;
  font-size: 12px;
  line-height: 1.6;
}

.settings__actions {
  display: flex;
  align-items: center;
  gap: 12px;
}
.settings__actions .el-button { margin-left: 0; }
.settings__test-result { margin-top: 16px; }
.settings__actions .settings__hint { margin: 0; }
@media(max-width: 600px) { .settings__actions { flex-wrap: wrap; } .settings__actions .settings__hint { flex-basis: 100%; } }
</style>
