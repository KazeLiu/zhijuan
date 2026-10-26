<script setup lang="ts">
import type { DocumentPreviewDTO } from '#shared/types'
import { DOCUMENT_PREVIEW_CHARS } from '#shared/constants'
const open = defineModel<boolean>({ required: true })
const props = defineProps<{ fileId: string }>()
const preview = ref<DocumentPreviewDTO | null>(null)
const pending = ref(false)
const error = ref('')
let request = 0
async function load(offset = 0) {
  const current = ++request
  pending.value = true; error.value = ''
  try {
    const result = await apiFetch<DocumentPreviewDTO>(`/api/admin/library/${props.fileId}/preview`, { query: { offset, limit: DOCUMENT_PREVIEW_CHARS }, silent: true })
    if (current === request) preview.value = result
  } catch (cause) { if (current === request) error.value = describeApiError(cause, '无法读取资料') }
  finally { if (current === request) pending.value = false }
}
watch([open, () => props.fileId], ([visible]) => { if (visible && props.fileId) { preview.value = null; void load() } })
</script>
<template>
  <el-dialog v-model="open" :title="preview?.originalName ?? '资料原文与定位'" width="min(860px, 94vw)" append-to-body>
    <StatePanel v-if="pending" state="loading" title="正在读取资料…" />
    <StatePanel v-else-if="error" state="error" :description="error" title="资料读取失败" @retry="load(preview?.offset ?? 0)" />
    <template v-else-if="preview">
      <p class="zj-muted">第 {{ preview.offset + 1 }}–{{ Math.min(preview.offset + preview.limit, preview.totalChars) }} 字 / 共 {{ preview.totalChars }} 字</p>
      <section v-for="(segment, index) in preview.segments" :key="`${segment.locator}-${index}`" class="source-preview">
        <strong>{{ segment.locator }}</strong><pre>{{ segment.text }}</pre>
      </section>
      <pre v-if="!preview.segments">{{ preview.text }}</pre>
    </template>
    <template #footer>
      <el-button :disabled="pending || !preview || preview.offset === 0" @click="load(Math.max(0, (preview?.offset ?? 0) - DOCUMENT_PREVIEW_CHARS))">上一段</el-button>
      <el-button :disabled="pending || !preview?.truncated" @click="load((preview?.offset ?? 0) + DOCUMENT_PREVIEW_CHARS)">下一段</el-button>
      <el-button @click="open = false">关闭</el-button>
    </template>
  </el-dialog>
</template>
<style scoped>
.source-preview { border-top: 1px solid var(--zj-border); padding-top: 12px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; line-height: 1.7; }
</style>
