<script setup lang="ts">
import type { AnswerDefinition, QuestionType, BankGenerationJobDTO, BankGenerationRequest, BankFileGenerationRequest, BankGenerationSourceSummary, BankMarkedPreviewDTO } from '#shared/types'
import { DIFFICULTY_LABELS, QUESTION_TYPES, QUESTION_TYPE_LABELS } from '#shared/types'
import { MAX_EXTRA_PROMPT_CHARS } from '#shared/constants'
const open = defineModel<boolean>({ required: true })
const props = defineProps<{ job: BankGenerationJobDTO | null; issuesOnly?: boolean }>()
const emit = defineEmits<{ created: [job: BankGenerationJobDTO] }>()
const { data: catalog, error: catalogError, refresh } = await useBankCatalog()
const form = reactive<BankFileGenerationRequest>({ libraryFileIds: [], documentMode: 'standard', difficulty: 'normal', extraPrompt: '' })
const preview = reactive({ data: null as BankMarkedPreviewDTO | null, busy: false, error: '' })
const mode = ref<'files' | 'supplement'>('files')
const supplement = reactive({ knowledgePoint: '', sourceIds: [] as string[], quantityMode: 'auto' as 'auto' | 'by_type', total: 5,
  counts: { single_choice: 3, multiple_choice: 0, true_false: 2, fill_blank: 0 } })
const { data: sources, error: sourcesError, pending: sourcesPending, refresh: reloadSources } = await useAsyncData<BankGenerationSourceSummary[]>(
  'zj-bank-generation-sources', () => apiFetch<BankGenerationSourceSummary[]>('/api/admin/question-bank/generation/sources', { silent: true }), { server: false, immediate: false })
const sourcePoints = computed(() => [...new Set((sources.value ?? []).map((source) => source.knowledgePoint))])
const sourceOptions = computed(() => (sources.value ?? []).filter((source) => !supplement.knowledgePoint || source.knowledgePoint === supplement.knowledgePoint))
const input = computed<BankGenerationRequest>(() => mode.value === 'files'
  ? { libraryFileIds: form.libraryFileIds, documentMode: form.documentMode, difficulty: form.difficulty, extraPrompt: form.extraPrompt.trim() }
  : { mode: 'supplement', sourceIds: supplement.sourceIds, difficulty: form.difficulty, extraPrompt: form.extraPrompt.trim(),
      quantity: supplement.quantityMode === 'auto' ? { mode: 'auto', total: supplement.total } : { mode: 'by_type', counts: { ...supplement.counts } } })
const busy = ref(false)
const error = ref('')
const active = computed(() => props.job?.status === 'queued' || props.job?.status === 'running')
const sameInput = computed(() => {
  const previous = props.job?.input, next = input.value
  if (!previous || next.difficulty !== previous.difficulty || next.extraPrompt !== previous.extraPrompt) return false
  if (previous.mode === 'supplement') return next.mode === 'supplement'
    && JSON.stringify([...next.sourceIds].sort()) === JSON.stringify([...previous.sourceIds].sort()) && JSON.stringify(next.quantity) === JSON.stringify(previous.quantity)
  return next.mode !== 'supplement' && (next.documentMode ?? 'standard') === (previous.documentMode ?? 'standard')
    && JSON.stringify([...next.libraryFileIds].sort()) === JSON.stringify([...previous.libraryFileIds].sort())
})
const canGenerate = computed(() => mode.value === 'files' ? form.libraryFileIds.length > 0 : supplement.sourceIds.length > 0
  && (supplement.quantityMode === 'auto' ? supplement.total >= 1 && supplement.total <= 100 : Object.values(supplement.counts).reduce((sum, count) => sum + count, 0) >= 1 && Object.values(supplement.counts).reduce((sum, count) => sum + count, 0) <= 100))
const groups = computed(() => {
  const result = new Map<string, BankGenerationJobDTO['sources']>()
  for (const source of props.job?.sources ?? []) {
    const sources = result.get(source.knowledgePoint) ?? []
    sources.push(source)
    result.set(source.knowledgePoint, sources)
  }
  return [...result].map(([name, sources]) => ({ name, sources }))
})
const currentSource = computed(() => props.job?.sources.find((source) => !source.completed))
const markedFiles = computed(() => mode.value === 'files' && form.documentMode === 'marked')
const markedJob = computed(() => props.job?.sources.some((source) => source.markedRules))
watch([() => form.documentMode, () => form.libraryFileIds.join('|')], () => { preview.data = null; preview.error = '' })
watch(open, async (value) => {
  if (value) {
    error.value = ''
    await reloadSources()
    if (props.job && !form.libraryFileIds.length && !supplement.sourceIds.length) {
      const previous = props.job.input
      if (previous.mode === 'supplement') {
        mode.value = 'supplement'
        supplement.sourceIds = [...previous.sourceIds]
        supplement.quantityMode = previous.quantity.mode
        if (previous.quantity.mode === 'auto') supplement.total = previous.quantity.total
        else Object.assign(supplement.counts, previous.quantity.counts)
      } else {
        form.libraryFileIds = [...previous.libraryFileIds]
        form.documentMode = previous.documentMode ?? 'standard'
      }
      form.difficulty = props.job.input.difficulty
      form.extraPrompt = props.job.input.extraPrompt
    }
  }
}, { immediate: true })
watch(() => props.job?.stage, (stage, previous) => { if (open.value && stage === 'generation' && previous === 'analysis') void reloadSources() })
watch(() => props.job?.status, (status) => { if (open.value && (status === 'succeeded' || status === 'failed')) void reloadSources() })
function selectPointSources() {
  const matching = supplement.knowledgePoint ? sourceOptions.value.map((source) => source.id) : []
  supplement.sourceIds = matching.length <= 100 ? matching : []
  error.value = matching.length > 100 ? '此知识点超过 100 个来源，请从列表中选择本次要补题的来源' : ''
}
async function supplementFor(knowledgePoint: string, sourceId?: string) {
  if (active.value || busy.value) return
  await reloadSources()
  mode.value = 'supplement'
  const source = sourceId ? sources.value?.find((item) => item.id === sourceId) : undefined
  if (sourceId && !source) { error.value = '此来源已不可用，请从当前清单重新选择'; return }
  supplement.knowledgePoint = source?.knowledgePoint ?? knowledgePoint
  if (sourceId) supplement.sourceIds = [sourceId]
  else selectPointSources()
}
function answerLabel(type: QuestionType, answer: AnswerDefinition): string {
  if (type === 'fill_blank') return answer.blanks.map((blank) => blank.acceptedAnswers.join(' / ')).join('；')
  if (type === 'true_false') return answer.correctOptionIds[0] === 'true' ? '正确' : '错误'
  return answer.correctOptionIds.join('、')
}
async function previewSources() {
  if (preview.busy || active.value || !form.libraryFileIds.length) return
  preview.busy = true; preview.error = ''
  try {
    preview.data = await apiFetch<BankMarkedPreviewDTO>('/api/admin/question-bank/generation/preview', {
      method: 'POST', body: { libraryFileIds: form.libraryFileIds }, silent: true,
    })
  } catch (cause) { preview.error = describeApiError(cause, '解析来源失败') }
  finally { preview.busy = false }
}
async function generate(resume = false) {
  if (active.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    const job = resume && props.job
      ? await apiFetch<BankGenerationJobDTO>(`/api/admin/question-bank/generation/${props.job.id}/retry`, { method: 'POST', silent: true })
      : await apiFetch<BankGenerationJobDTO>('/api/admin/question-bank/generate', { method: 'POST', body: input.value, silent: true })
    emit('created', job)
  } catch (cause) {
    const fields = Object.values(readFieldErrors(cause))
    error.value = fields.length ? fields.join('；') : describeApiError(cause, '创建生成任务失败')
  } finally { busy.value = false }
}
</script>

<template>
  <el-dialog v-model="open" :title="issuesOnly ? '题库生成问题列表' : 'AI 生成题库题目'" width="min(720px, 94vw)" :close-on-click-modal="false">
    <el-form v-if="!issuesOnly" label-position="top" :disabled="busy || active || preview.busy">
      <el-form-item><el-radio-group v-model="mode"><el-radio-button value="files">按资料生成</el-radio-button><el-radio-button value="supplement">定向补题</el-radio-button></el-radio-group></el-form-item>
      <el-form-item v-if="mode === 'files'" label="来源资料" required>
        <el-select v-model="form.libraryFileIds" multiple filterable :multiple-limit="5" placeholder="选择资料库文件，最多 5 份" style="width:100%">
          <el-option v-for="file in catalog?.files ?? []" :key="file.id" :label="file.originalName" :value="file.id" />
        </el-select>
      </el-form-item>
      <el-alert v-if="mode === 'files' && catalogError" type="error" :closable="false" title="资料加载失败"><el-button @click="refresh()">重新加载</el-button></el-alert>
      <NuxtLink v-if="mode === 'files' && catalog && !catalog.files.length" to="/admin/library">去资料库上传资料</NuxtLink>
      <el-form-item v-if="mode === 'files'" label="资料规则">
        <el-radio-group v-model="form.documentMode"><el-radio-button value="standard">普通资料</el-radio-button><el-radio-button value="marked">★ 与 &lt;&gt; 标记</el-radio-button></el-radio-group>
      </el-form-item>
      <template v-if="markedFiles">
        <el-alert v-if="preview.error" :title="preview.error" type="error" :closable="false" />
        <div v-if="preview.data" class="bank-generate__preview">
          <div class="bank-generate__preview-header"><span>{{ preview.data.sources.length }} 个完整来源 · {{ preview.data.sources.reduce((sum, source) => sum + source.blankQuestionCount, 0) }} 道原文填空</span><el-button text @click="previewSources" :loading="preview.busy">重新解析</el-button></div>
          <el-table :data="preview.data.sources" max-height="360">
            <el-table-column type="expand"><template #default="{ row }"><AdminMarkedSourceView :rules="row.rules" /></template></el-table-column>
            <el-table-column prop="title" label="来源" min-width="180" show-overflow-tooltip />
            <el-table-column prop="fileName" label="资料" min-width="130" show-overflow-tooltip />
            <el-table-column prop="knowledgePoint" label="所属章节" min-width="150" show-overflow-tooltip />
            <el-table-column label="熟记" width="80"><template #default="{ row }">{{ row.rules.sections.some((section: { memorize: boolean }) => section.memorize) ? '★' : '—' }}</template></el-table-column>
            <el-table-column prop="blankQuestionCount" label="填空题" width="80" align="right" />
          </el-table>
        </div>
        <p class="zj-muted">父级 ★ 由子项继承，熟记内容的 &lt;&gt; 直接生成填空；普通内容只出判断和选择。带子项的完整条目归为同源，一卷最多抽一道。</p>
      </template>
      <template v-if="mode === 'supplement'">
        <el-alert v-if="sourcesError" type="error" :closable="false" title="来源清单加载失败"><el-button @click="reloadSources()">重新加载</el-button></el-alert>
        <el-empty v-else-if="!sourcesPending && !sources?.length" description="暂无已梳理的来源"><el-button @click="mode = 'files'">先按资料生成</el-button></el-empty>
        <el-form-item label="知识点"><el-select v-model="supplement.knowledgePoint" filterable clearable placeholder="选择知识点，可一并选中其下来源" style="width:100%" @change="selectPointSources"><el-option v-for="point in sourcePoints" :key="point" :label="point" :value="point" /></el-select></el-form-item>
        <el-form-item label="补题来源" required>
          <el-select v-model="supplement.sourceIds" multiple filterable collapse-tags collapse-tags-tooltip :multiple-limit="100" :loading="sourcesPending" placeholder="选择已有来源，最多 100 个" style="width:100%">
            <el-option v-for="source in sourceOptions" :key="source.id" :value="source.id" :label="`${source.documentMode === 'marked' ? '【标记】' : ''}${source.title} · ${source.fileName} · 已有 ${source.questionCount} 道`" />
          </el-select>
        </el-form-item>
        <el-form-item label="本次新增题量（选中范围合计）">
          <el-radio-group v-model="supplement.quantityMode"><el-radio-button value="auto">AI 分配题型</el-radio-button><el-radio-button value="by_type">指定各题型</el-radio-button></el-radio-group>
          <div v-if="supplement.quantityMode === 'auto'" class="bank-generate__quantity"><el-input-number v-model="supplement.total" :min="1" :max="100" :precision="0" aria-label="本次新增总题量" /><span>道</span></div>
          <div v-else class="bank-generate__counts"><label v-for="type in QUESTION_TYPES" :key="type"><span>{{ QUESTION_TYPE_LABELS[type] }}</span><el-input-number v-model="supplement.counts[type]" :min="0" :max="100" :precision="0" :aria-label="`${QUESTION_TYPE_LABELS[type]}新增数量`" /></label></div>
        </el-form-item>
      </template>
      <el-form-item label="难度"><el-radio-group v-model="form.difficulty"><el-radio-button v-for="(label, value) in DIFFICULTY_LABELS" :key="value" :value="value">{{ label }}</el-radio-button></el-radio-group></el-form-item>
      <el-form-item label="补充要求"><el-input v-model="form.extraPrompt" type="textarea" :rows="3" :maxlength="MAX_EXTRA_PROMPT_CHARS" show-word-limit placeholder="例如：保留原题问法，并补充适合的判断题、多选题" /></el-form-item>
    </el-form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div v-if="job" class="bank-generate__job">
      <template v-if="active">
        <p>{{ job.status === 'queued' ? '已排队，等待出题执行器' : job.stage === 'analysis' ? '正在通读全文，归纳知识点并整理完整来源…' : `正在逐个请求出题 · 已处理 ${job.progressDone} / ${job.progressTotal} 个请求${job.issues.length ? `，其中失败 ${job.issues.length} 个` : ''}${job.progressTotal > job.progressDone ? `，待处理 ${job.progressTotal - job.progressDone} 个` : ''}` }}</p>
        <el-progress v-if="job.stage === 'generation' && job.progressTotal" :percentage="Math.min(100, Math.round(job.progressDone / job.progressTotal * 100))" />
        <p class="zj-muted">{{ markedJob ? '填空按标记直接生成，判断和选择逐题请求模型。' : '按来源逐题生成，每次一道，保存后再出下一道。' }}可以关闭窗口，任务会继续；模型请求失败最多尝试 3 次，仍失败则记录原因并继续。</p>
      </template>
      <el-alert v-else-if="job.status === 'succeeded'" :type="job.conflicts.length || job.requestedCount !== null && job.createdCount < job.requestedCount ? 'warning' : 'success'" :closable="false" :title="`已入库 ${job.createdCount} 道${job.requestedCount !== null ? `，目标 ${job.requestedCount} 道` : ''}${job.duplicateCount ? `，相同题跳过 ${job.duplicateCount} 道` : ''}${job.conflicts.length ? `，答案冲突 ${job.conflicts.length} 道未入库` : ''}`" />
      <el-alert v-else type="error" :closable="false" :title="issuesOnly ? `生成任务已结束 · 已入库 ${job.createdCount} 道 · 存在 ${job.issues.length} 项问题` : job.errorMessage" />
      <p v-if="issuesOnly && job.progressTotal > job.progressDone" class="zj-muted">还有 {{ job.progressTotal - job.progressDone }} 个请求未处理。</p>
      <el-table v-if="job.issues.length" :data="job.issues" size="small" max-height="360" class="bank-generate__issues">
        <el-table-column prop="sourceTitle" label="来源 / 阶段" min-width="150" show-overflow-tooltip />
        <el-table-column label="请求" width="70"><template #default="{ row }">{{ row.requestIndex === null ? '—' : `第 ${row.requestIndex} 个` }}</template></el-table-column>
        <el-table-column label="尝试" width="90"><template #default="{ row }">{{ row.attempts === null ? '—' : row.attempts === 0 ? '本地处理' : `${row.attempts} 次` }}</template></el-table-column>
        <el-table-column prop="message" label="失败原因" min-width="260" />
      </el-table>
      <template v-if="!issuesOnly && job.sources.length">
        <p>{{ groups.length }} 个知识点 · {{ job.sources.length }} 个来源 · 已入库 {{ job.createdCount }} 道<span v-if="job.duplicateCount"> · 相同题跳过 {{ job.duplicateCount }} 道</span><span v-if="job.issues.length"> · 失败请求 {{ job.issues.length }} 个</span></p>
        <el-collapse class="bank-generate__sources">
          <el-collapse-item v-for="group in groups" :key="group.name" :name="group.name">
            <template #title><div class="bank-generate__group"><span>{{ group.name }} · {{ group.sources.length }} 个来源</span><el-button text type="primary" :disabled="active || busy" @click.stop="supplementFor(group.name)">补题</el-button></div></template>
            <el-table :data="group.sources" size="small">
              <el-table-column v-if="markedJob" type="expand"><template #default="{ row }"><AdminMarkedSourceView v-if="row.markedRules" :rules="row.markedRules" /></template></el-table-column>
              <el-table-column prop="title" label="来源" min-width="180" show-overflow-tooltip />
              <el-table-column label="原文位置" min-width="180" show-overflow-tooltip><template #default="{ row }">{{ row.fileName }} · {{ row.locators.join('、') }}</template></el-table-column>
              <el-table-column label="状态" width="170"><template #default="{ row }"><el-tooltip :disabled="!row.shortfallReason" :content="row.shortfallReason"><span>{{ row.failedCount ? `已入库 ${row.createdCount} 道 · 失败 ${row.failedCount} 个请求` : row.completed ? `已入库 ${row.createdCount}${row.requestedCount !== null ? ` / ${row.requestedCount}` : ''} 道` : active && job.status === 'running' && row === currentSource ? `正在生成 · ${row.createdCount} 道` : '待处理' }}</span></el-tooltip></template></el-table-column>
              <el-table-column width="65"><template #default="{ row }"><el-button text type="primary" :disabled="active || busy || !row.id" @click="supplementFor(group.name, row.id)">补题</el-button></template></el-table-column>
            </el-table>
          </el-collapse-item>
          <el-collapse-item v-if="job.ignored.length" name="__ignored" :title="`未用于出题的片段 · ${job.ignored.length} 项`">
            <el-table :data="job.ignored" size="small">
              <el-table-column label="原文位置" min-width="220" show-overflow-tooltip><template #default="{ row }">{{ row.fileName }} · {{ row.locators.join('、') }}</template></el-table-column>
              <el-table-column prop="reason" label="原因" min-width="200" />
            </el-table>
          </el-collapse-item>
          <el-collapse-item v-if="job.conflicts.length" name="__conflicts" :title="`答案冲突，未入库 · ${job.conflicts.length} 道`">
            <el-table :data="job.conflicts" size="small">
              <el-table-column label="题目" min-width="180"><template #default="{ row }"><NuxtLink :to="`/admin/question-bank?itemId=${row.itemId}`" @click="open = false">{{ row.stem }}</NuxtLink></template></el-table-column>
              <el-table-column label="已有答案" min-width="100"><template #default="{ row }">{{ answerLabel(row.type, row.existingAnswer) }}</template></el-table-column>
              <el-table-column label="本次答案" min-width="100"><template #default="{ row }">{{ answerLabel(row.type, row.generatedAnswer) }}</template></el-table-column>
            </el-table>
          </el-collapse-item>
        </el-collapse>
      </template>
    </div>
    <template #footer>
      <el-button :disabled="busy || preview.busy" @click="open = false">关闭</el-button>
      <el-button v-if="!issuesOnly && markedFiles && !preview.data" type="primary" :loading="preview.busy" :disabled="active || !canGenerate" @click="previewSources">解析来源</el-button>
      <el-button v-else-if="!issuesOnly" :type="job?.status === 'failed' && sameInput ? 'default' : 'primary'" :loading="busy" :disabled="active || preview.busy || !canGenerate" @click="generate()">{{ mode === 'supplement' ? '开始补题' : job ? '新建生成任务' : '生成并入库' }}</el-button>
      <el-button v-if="job?.status === 'failed' && (issuesOnly || sameInput)" type="primary" :loading="busy" @click="generate(true)">{{ !job.sources.length ? '重新梳理全文' : job.issues.some(issue => issue.requestIndex !== null) ? '仅重试失败部分' : '继续未完成来源' }}</el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.bank-generate__job { margin-top: 16px; }
.bank-generate__issues { margin-top: 16px; }
.bank-generate__preview { margin-bottom: 16px; }
.bank-generate__preview-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.bank-generate__sources { max-height: 360px; overflow: auto; }
.bank-generate__quantity { display: flex; align-items: center; gap: 8px; width: 100%; margin-top: 12px; }
.bank-generate__counts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 24px; width: 100%; margin-top: 12px; }
.bank-generate__counts label { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.bank-generate__group { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
@media (max-width: 600px) {
  .bank-generate__counts { grid-template-columns: 1fr; }
}
</style>
