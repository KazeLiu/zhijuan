<script setup lang="ts">
/**
 * 填空答案批量纠错：按空位把同一写法勾成一组，预览真实影响后按确定规则重判自动分。
 * 只改标准答案与自动分，不接 AI、不改题型/题干/空位，人工复核分保持不动。
 */
import type { BlankCorrectionPageDTO, BlankCorrectionPreviewDTO } from '#shared/types'
import { MAX_GRADE_REASON_CHARS, PASS_SCORE_UNITS } from '#shared/constants'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const examId = computed(() => String(route.params.id ?? ''))

const { data, error, pending, refresh } = await useAsyncData<BlankCorrectionPageDTO>(
  () => `zj-blank-corrections:${examId.value}`,
  () => apiFetch<BlankCorrectionPageDTO>(`/api/admin/exams/${examId.value}/blank-corrections`, { silent: true }),
  { server: false },
)

useHead({
  title: computed(() => (data.value ? `知卷 · ${data.value.exam.title} 填空答案纠错` : '知卷 · 填空答案纠错')),
})

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')
const canCorrect = computed(() => data.value?.canCorrect === true)
const questions = computed(() => data.value?.questions ?? [])
const history = computed(() => data.value?.history ?? [])

/** 勾选按「题目|空位」键存组值（groups.value）；提交时再合并成 selections */
const selection = reactive<Record<string, string[]>>({})
const reason = ref('')
const syncToBank = ref(false)
const preview = ref<BlankCorrectionPreviewDTO | null>(null)
const previewing = ref(false)
const applying = ref(false)
const busy = computed(() => previewing.value || applying.value)
const formError = ref('')
const conflict = ref('')

const blankKey = (questionId: string, blankId: string): string => `${questionId}|${blankId}`

function blankSelection(questionId: string, blankId: string): string[] {
  return selection[blankKey(questionId, blankId)] ?? []
}

function onGroupChange(questionId: string, blankId: string, value: unknown): void {
  selection[blankKey(questionId, blankId)] = Array.isArray(value) ? value.map(String) : []
}

const selectedGroupCount = computed(() =>
  questions.value.reduce(
    (sum, question) => sum + question.blanks.reduce((count, blank) => count + blankSelection(question.id, blank.id).length, 0),
    0,
  ),
)
const dirty = computed(() => selectedGroupCount.value > 0 || reason.value.trim() !== '' || preview.value !== null)
const canPreview = computed(
  () =>
    canCorrect.value &&
    !busy.value &&
    questions.value.length > 0 &&
    reason.value.trim() !== '' &&
    (selectedGroupCount.value > 0 || (data.value?.policyRegradeCount ?? 0) > 0),
)

// 选择、同步开关或原因一变，旧预览立即失效，避免用旧 previewId 提交新选择
watch([() => JSON.stringify(selection), syncToBank, reason], () => {
  preview.value = null
  conflict.value = ''
})

function buildSelections(): Array<{ questionId: string; blankId: string; answers: string[] }> {
  const rows: Array<{ questionId: string; blankId: string; answers: string[] }> = []
  for (const question of questions.value) {
    for (const blank of question.blanks) {
      const values = blankSelection(question.id, blank.id)
      if (values.length) rows.push({ questionId: question.id, blankId: blank.id, answers: [...values] })
    }
  }
  return rows
}

function describe(cause: unknown, fallback: string): string {
  const fields = Object.values(readFieldErrors(cause))
  return fields.length ? fields.join('；') : describeApiError(cause, fallback)
}

function resetForm(): void {
  for (const key of Object.keys(selection)) delete selection[key]
  reason.value = ''
  syncToBank.value = false
}

async function createPreview(): Promise<void> {
  const current = data.value
  if (!current || !canPreview.value) return
  previewing.value = true
  formError.value = ''
  conflict.value = ''
  try {
    preview.value = await apiFetch<BlankCorrectionPreviewDTO>(
      `/api/admin/exams/${examId.value}/blank-corrections/preview`,
      {
        method: 'POST',
        body: {
          expectedVersion: current.exam.version,
          selections: buildSelections(),
          syncToBank: syncToBank.value,
          reason: reason.value.trim(),
        },
        silent: true,
      },
    )
  } catch (cause) {
    preview.value = null
    const message = describe(cause, '预览纠错影响失败')
    if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') conflict.value = `${message}；本地勾选已保留。`
    else formError.value = message
  } finally {
    previewing.value = false
  }
}

async function applyPreview(): Promise<void> {
  const current = preview.value
  if (!current || busy.value || !canCorrect.value) return
  applying.value = true
  try {
    await ElMessageBox.confirm(
      `将按更正后的标准答案重判 ${current.impacts.length} 份答卷的自动分，人工复核分保持不变。确认应用？`,
      '应用填空答案纠错',
      { confirmButtonText: '确认应用', cancelButtonText: '再看看', type: 'warning' },
    )
  } catch {
    applying.value = false
    return
  }
  if (preview.value?.id !== current.id) { applying.value = false; return }
  formError.value = ''
  conflict.value = ''
  try {
    const result = await apiFetch<BlankCorrectionPreviewDTO>(
      `/api/admin/exams/${examId.value}/blank-corrections/apply`,
      { method: 'POST', body: { previewId: current.id }, silent: true },
    )
    preview.value = null
    resetForm()
    ElMessage.success(`纠错已应用：${result.impacts.length} 份答卷已重判，题库同步 ${result.bankSyncedCount} 道`)
    clearNuxtData(['zj-admin-exam-results', 'zj-admin-exam-detail', 'zj-admin-bank', 'zj-admin-mistakes', 'zj-my-attempts', 'zj-my-mistakes', 'zj-rolling'])
    await refresh()
  } catch (cause) {
    // 不自动重试：版本冲突时保留勾选，让用户重新加载后自己决定是否重新预览
    preview.value = null
    const message = describe(cause, '应用纠错失败')
    if (cause instanceof ApiClientError && cause.code === 'VERSION_CONFLICT') conflict.value = `${message}；本地勾选已保留。`
    else formError.value = message
  } finally {
    applying.value = false
  }
}

async function refreshPage(): Promise<void> {
  if (dirty.value) {
    try {
      await ElMessageBox.confirm('刷新会丢弃当前勾选与预览。', '刷新页面', {
        confirmButtonText: '刷新',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch {
      return
    }
    resetForm()
    preview.value = null
  }
  await refresh()
}

async function reloadPreservingSelection(): Promise<void> {
  conflict.value = ''
  formError.value = ''
  await refresh()
  if (error.value || !data.value) return
  const allowed = new Map(data.value.questions.flatMap((question) => question.blanks.map((blank) =>
    [blankKey(question.id, blank.id), new Set(blank.groups.map((group) => group.value))] as const)))
  let removed = 0
  for (const key of Object.keys(selection)) {
    const retained = selection[key]!.filter((value) => allowed.get(key)?.has(value))
    removed += selection[key]!.length - retained.length
    if (retained.length) selection[key] = retained
    else delete selection[key]
  }
  if (removed) ElMessage.warning(`已移除 ${removed} 个已变化或已认可的写法，其余勾选保留，请重新预览`)
}

function scorePair(before: number, after: number): string {
  return `${formatScoreUnits(before)} → ${formatScoreUnits(after)}`
}

function passLabel(passed: boolean): string {
  return passed ? '及格' : '不及格'
}

function listText(values: string[]): string {
  return values.length ? values.join('、') : '—'
}

function answersText(values: string[]): string {
  return values.length ? values.join(' / ') : '—'
}

function historyTitle(record: BlankCorrectionPreviewDTO): string {
  const added = record.changes.reduce((sum, change) => sum + change.added.length, 0)
  return `${record.appliedBy ?? '—'} · ${formatDateTime(record.appliedAt)} · 新增 ${added} 种写法 / 受影响 ${record.impacts.length} 份`
}

async function allowLeave(): Promise<boolean> {
  if (busy.value) return false
  if (!dirty.value) return true
  try {
    await ElMessageBox.confirm('离开将放弃尚未提交的填空纠错勾选与预览。', '未保存的纠错', {
      confirmButtonText: '放弃离开',
      cancelButtonText: '继续编辑',
      type: 'warning',
    })
    return true
  } catch {
    return false
  }
}

onBeforeRouteLeave(allowLeave)

function guardUnload(event: BeforeUnloadEvent): void {
  if (busy.value || dirty.value) {
    event.preventDefault()
    event.returnValue = ''
  }
}

onMounted(() => window.addEventListener('beforeunload', guardUnload))
onBeforeUnmount(() => window.removeEventListener('beforeunload', guardUnload))
</script>

<template>
  <section class="bc">
    <PageHeader
      :title="data ? `${data.exam.title} · 填空答案纠错` : '填空答案纠错'"
      :description="
        data ? `已交卷 ${data.submittedCount} 份；按现有评分规则可更新成绩的有 ${data.policyRegradeCount} 份。` : ''
      "
      :back-to="`/admin/exams/${examId}/results`"
      back-text="返回成绩汇总"
    >
      <template #actions>
        <el-button :loading="pending" :disabled="busy" @click="refreshPage">刷新</el-button>
      </template>
    </PageHeader>

    <StatePanel
      v-if="error"
      :state="forbidden ? 'forbidden' : 'error'"
      :title="forbidden ? '需要管理员权限' : '加载填空纠错失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : '/admin/exams'"
      :action-text="forbidden ? '重新登录' : '返回场次列表'"
      @retry="reloadPreservingSelection"
    />

    <StatePanel v-else-if="!data" state="loading" title="正在统计判错写法…" :loading-rows="5" />

    <template v-else-if="data">
      <el-alert v-if="!data.canCorrect" type="warning" :closable="false" show-icon :title="data.lockReason" class="bc__alert" />

      <StatePanel
        v-if="questions.length === 0"
        state="empty"
        title="本场没有填空题"
        description="只有填空题存在按写法归组纠错的场景，本场无需处理。"
        action-text="返回成绩汇总"
        :action-to="`/admin/exams/${examId}/results`"
      />

      <template v-else>
        <el-card v-for="question in questions" :key="question.id" shadow="never">
          <template #header>
            <div class="bc__question-head">
              <span class="zj-tabular">第 {{ question.position }} 题</span>
              <span class="zj-muted bc__question-stem">{{ formatQuestionStem(question.stem, 'fill_blank') }}</span>
            </div>
          </template>

          <div v-for="blank in question.blanks" :key="blank.id" class="bc__blank">
            <p class="bc__blank-meta">
              <span class="zj-tabular">第 {{ blank.position }} 空</span>
              <span class="zj-muted">标准答案：{{ answersText(blank.acceptedAnswers) }}</span>
            </p>

            <p v-if="blank.groups.length === 0" class="zj-muted bc__blank-empty">没有判错的写法</p>

            <el-checkbox-group
              v-else
              :model-value="blankSelection(question.id, blank.id)"
              :disabled="!canCorrect || busy"
              class="bc__groups"
              @update:model-value="onGroupChange(question.id, blank.id, $event)"
            >
              <el-checkbox v-for="group in blank.groups" :key="group.value" :value="group.value" class="bc__group">
                <span class="bc__group-label">{{ group.label }}</span>
                <span class="zj-muted zj-tabular bc__group-people">{{ group.people }} 人</span>
                <el-tooltip
                  v-if="group.spellings.length > 1"
                  :content="group.spellings.join(' / ')"
                  placement="top"
                >
                  <span class="zj-muted bc__group-spellings">{{ group.spellings.length }} 种原始写法</span>
                </el-tooltip>
              </el-checkbox>
            </el-checkbox-group>
          </div>
        </el-card>

        <el-card shadow="never">
          <el-input
            v-model="reason"
            type="textarea"
            :rows="2"
            :maxlength="MAX_GRADE_REASON_CHARS"
            show-word-limit
            :disabled="!canCorrect || busy"
            placeholder="纠错原因（必填，会记入纠错记录）"
            aria-label="纠错原因"
          />
          <div class="bc__form-row">
            <el-checkbox v-model="syncToBank" :disabled="!canCorrect || busy">同步选中别名到题库</el-checkbox>
            <span class="zj-muted bc__form-hint">只同步本场选中别名的题库题，不重写其他历史场次。</span>
          </div>
          <div class="bc__form-row">
            <el-button
              type="primary"
              :loading="previewing"
              :disabled="!canPreview"
              @click="createPreview"
            >
              预览影响
            </el-button>
            <span class="zj-muted">已选 {{ selectedGroupCount }} 个写法<span v-if="data.policyRegradeCount > 0">；也可直接预览现有规则的重判</span></span>
          </div>
          <el-alert v-if="formError" type="error" :closable="false" show-icon :title="formError" class="bc__alert" />
          <el-alert v-if="conflict" type="warning" :closable="false" show-icon :title="conflict" class="bc__alert">
            <template #default>
              <div class="bc__conflict">
                <span>请重新加载后再预览确认，不要沿用旧预览。</span>
                <el-button size="small" :disabled="busy" @click="reloadPreservingSelection">重新加载</el-button>
              </div>
            </template>
          </el-alert>
        </el-card>

        <el-card v-if="preview" shadow="never">
          <template #header>
            <div class="bc__summary">
              <span>待确认的纠错预览</span>
              <span class="zj-muted">
                受影响答卷 {{ preview.impacts.length }} 份 · 最终总分变化 {{ preview.scoreChangedCount }} 人 · 保留人工项
                {{ preview.manualPreservedCount }} 个 · 题库同步 {{ preview.bankSyncedCount }} 道
              </span>
            </div>
          </template>

          <p class="zj-muted bc__preview-hint">
            人工复核分保持原值，最终总分按保留的人工分与新的自动分计算。
          </p>

          <div class="bc__table-title">{{ preview.changes.length ? '写法更正' : '按统一规则重判' }}</div>
          <el-table v-if="preview.changes.length" :data="preview.changes" size="small" max-height="240">
            <el-table-column label="题号" width="70" align="center">
              <template #default="{ row }"><span class="zj-tabular">{{ row.position }}</span></template>
            </el-table-column>
            <el-table-column label="空位" width="80">
              <template #default="{ row }"><span class="zj-tabular">{{ row.blankId }}</span></template>
            </el-table-column>
            <el-table-column label="新增写法" min-width="140">
              <template #default="{ row }">{{ listText(row.added) }}</template>
            </el-table-column>
            <el-table-column label="原标准答案" min-width="160">
              <template #default="{ row }">{{ answersText(row.before) }}</template>
            </el-table-column>
            <el-table-column label="更正后标准答案" min-width="160">
              <template #default="{ row }">{{ answersText(row.after) }}</template>
            </el-table-column>
          </el-table>

          <div class="bc__table-title">答卷影响</div>
          <el-table :data="preview.impacts" size="small" row-key="attemptId" max-height="360">
            <el-table-column prop="name" label="姓名" min-width="110" />
            <el-table-column label="自动分（前 → 后）" width="170" align="right">
              <template #default="{ row }"><span class="zj-tabular">{{ scorePair(row.autoBefore, row.autoAfter) }}</span></template>
            </el-table-column>
            <el-table-column label="最终总分（前 → 后）" width="180" align="right">
              <template #default="{ row }"><span class="zj-tabular">{{ scorePair(row.totalBefore, row.totalAfter) }}</span></template>
            </el-table-column>
            <el-table-column width="170">
              <template #header>
                <el-tooltip :content="`及格线 ${formatScoreUnits(PASS_SCORE_UNITS)} 分`" placement="top">
                  <span>及格（前 → 后）</span>
                </el-tooltip>
              </template>
              <template #default="{ row }">
                <span class="bc__pass">{{ passLabel(row.passedBefore) }} → {{ passLabel(row.passedAfter) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="保留人工项" width="110" align="right">
              <template #default="{ row }">
                <span class="zj-tabular">{{ row.manualPreserved > 0 ? `${row.manualPreserved} 项` : '—' }}</span>
              </template>
            </el-table-column>
          </el-table>

          <el-alert v-for="(warning, index) in preview.warnings" :key="index" type="warning" :closable="false" show-icon :title="warning" class="bc__alert" />
          <div class="bc__actions">
            <el-button type="primary" :loading="applying" :disabled="busy || !canCorrect" @click="applyPreview">确认应用</el-button>
            <el-button :disabled="busy" @click="preview = null">放弃预览</el-button>
          </div>
        </el-card>

        <el-card v-if="history.length" shadow="never">
          <template #header>
            <div class="bc__summary">
              <span>已应用的纠错记录</span>
              <span class="zj-muted">最近 {{ history.length }} 次</span>
            </div>
          </template>
          <el-collapse>
            <el-collapse-item v-for="record in history" :key="record.id" :name="record.id" :title="historyTitle(record)">
              <p class="zj-muted bc__history-reason">原因：{{ record.reason }}</p>
              <p class="zj-muted">
                最终总分变化 {{ record.scoreChangedCount }} 人 · 保留人工项 {{ record.manualPreservedCount }} 个 · 题库同步
                {{ record.bankSyncedCount }} 道
              </p>
              <el-table v-if="record.changes.length" :data="record.changes" size="small" max-height="200">
                <el-table-column label="题号" width="70" align="center">
                  <template #default="{ row }"><span class="zj-tabular">{{ row.position }}</span></template>
                </el-table-column>
                <el-table-column label="空位" width="80">
                  <template #default="{ row }"><span class="zj-tabular">{{ row.blankId }}</span></template>
                </el-table-column>
                <el-table-column label="新增写法" min-width="140">
                  <template #default="{ row }">{{ listText(row.added) }}</template>
                </el-table-column>
                <el-table-column label="更正后标准答案" min-width="160">
                  <template #default="{ row }">{{ answersText(row.after) }}</template>
                </el-table-column>
              </el-table>
              <el-table :data="record.impacts" size="small" row-key="attemptId" max-height="280" class="bc__history-table">
                <el-table-column prop="name" label="姓名" min-width="110" />
                <el-table-column label="自动分（前 → 后）" width="170" align="right">
                  <template #default="{ row }"><span class="zj-tabular">{{ scorePair(row.autoBefore, row.autoAfter) }}</span></template>
                </el-table-column>
                <el-table-column label="最终总分（前 → 后）" width="180" align="right">
                  <template #default="{ row }"><span class="zj-tabular">{{ scorePair(row.totalBefore, row.totalAfter) }}</span></template>
                </el-table-column>
                <el-table-column label="及格（前 → 后）" width="170">
                  <template #default="{ row }">
                    <span class="bc__pass">{{ passLabel(row.passedBefore) }} → {{ passLabel(row.passedAfter) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="保留人工项" width="110" align="right">
                  <template #default="{ row }">
                    <span class="zj-tabular">{{ row.manualPreserved > 0 ? `${row.manualPreserved} 项` : '—' }}</span>
                  </template>
                </el-table-column>
              </el-table>
            </el-collapse-item>
          </el-collapse>
        </el-card>
      </template>
    </template>
  </section>
</template>

<style scoped>
.bc {
  width: 100%;
}

.bc > :not(.page-header) + * {
  margin-top: var(--zj-section-gap);
}

.bc__alert {
  margin-bottom: 12px;
}

.bc__question-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: baseline;
}

.bc__question-stem {
  flex: 1 1 260px;
  min-width: 0;
  line-height: 1.6;
}

.bc__blank + .bc__blank {
  margin-top: 24px;
  padding-top: 16px;
  border-top: 1px dashed var(--zj-border);
}

.bc__blank-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: baseline;
  margin: 0 0 8px;
}

.bc__blank-empty {
  margin: 0;
}

.bc__groups {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.bc__group {
  height: auto;
  margin-right: 0;
  padding: 4px 0;
  align-items: flex-start;
}

.bc__group-label {
  font-weight: 600;
}

.bc__group-people {
  margin-left: 12px;
}

.bc__group-spellings {
  margin-left: 12px;
  border-bottom: 1px dotted var(--zj-border);
}

.bc__form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
  margin-top: 12px;
}

.bc__form-hint {
  font-size: 14px;
}

.bc__summary {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: baseline;
}

.bc__preview-hint {
  margin: 0 0 12px;
}

.bc__table-title {
  margin: 4px 0 8px;
  font-weight: 600;
}

.bc__pass {
  white-space: nowrap;
}

.bc__actions {
  display: flex;
  gap: 12px;
  margin-top: 16px;
}

.bc__conflict {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: center;
}

.bc__history-reason {
  margin: 0 0 8px;
}

.bc__history-table {
  margin-top: 12px;
}

@media (max-width: 640px) {
  .bc__table-title {
    margin-top: 8px;
  }
}
</style>
