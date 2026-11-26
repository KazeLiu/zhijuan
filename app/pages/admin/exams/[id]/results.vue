<script setup lang="ts">
/**
 * 成绩汇总（契约 §9.2 / §8.5 #27、#28 / §10.5）：
 * 指标卡 + 考生表（每页 20）+ 逐题表现表 + 筛选 + Excel 导出（跟随筛选）。
 */
import type { CandidateResultRowDTO, ResultsPageDTO, ResultsQuery } from '#shared/types'
import { DEFAULT_PAGE_SIZE, PASS_SCORE_UNITS } from '#shared/constants'
import { QUESTION_TYPE_LABELS } from '#shared/types'

definePageMeta({ layout: 'admin' })

const route = useRoute()
const examId = computed(() => String(route.params.id ?? ''))

const page = ref(1)
const nameFilter = ref('')
const appliedName = ref('')
const passedFilter = ref<'' | 'true' | 'false'>('')
const manualFilter = ref<'' | 'true' | 'false'>('')

const { data, error, pending, refresh } = await useAsyncData<ResultsPageDTO>(
  'zj-admin-exam-results',
  () =>
    apiFetch<ResultsPageDTO>(`/api/admin/exams/${examId.value}/results`, {
      query: {
        page: page.value,
        name: appliedName.value || undefined,
        passed: passedFilter.value || undefined,
        manual: manualFilter.value || undefined,
      },
      silent: true,
    }),
  { server: false, watch: [page, appliedName, passedFilter, manualFilter] },
)

useHead({
  title: computed(() => (data.value ? `知卷 · ${data.value.exam.title} 成绩` : '知卷 · 成绩汇总')),
})

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')
const exam = computed(() => data.value?.exam ?? null)
const summary = computed(() => data.value?.summary ?? null)
const rows = computed<CandidateResultRowDTO[]>(() => data.value?.items ?? [])
const timeZone = computed(() => exam.value?.timeZone ?? browserTimeZone())

function scoreText(units: number | null | undefined): string {
  return units === null || units === undefined ? '—' : formatScoreUnits(units)
}

function rateText(rate: number | null | undefined): string {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(1)}%`
}

function applyFilters(): void {
  page.value = 1
  appliedName.value = nameFilter.value.trim()
}

function resetFilters(): void {
  nameFilter.value = ''
  appliedName.value = ''
  passedFilter.value = ''
  manualFilter.value = ''
  page.value = 1
}

const exporting = ref(false)
const exportError = ref('')

async function exportExcel(): Promise<void> {
  const current = exam.value
  if (!current) return
  exporting.value = true
  exportError.value = ''
  try {
    const params = new URLSearchParams()
    if (appliedName.value) params.set('name', appliedName.value)
    if (passedFilter.value) params.set('passed', passedFilter.value)
    if (manualFilter.value) params.set('manual', manualFilter.value)
    const query = params.toString()
    const stamp = formatDateTimeSeconds(Date.now(), timeZone.value).replace(/[-: ]/g, '').slice(0, 12)
    await downloadFile(
      `/api/admin/exams/${examId.value}/results/export${query ? `?${query}` : ''}`,
      `${current.title}-成绩汇总-${stamp}.xlsx`,
    )
  } catch (error) {
    exportError.value = error instanceof Error ? error.message : '导出失败'
  } finally {
    exporting.value = false
  }
}

/** el-table 插槽 row 为 DefaultRow，统一在脚本内收窄类型 */
function openAttempt(record: unknown): void {
  const row = record as CandidateResultRowDTO
  void navigateTo(`/admin/attempts/${row.attemptId}`)
}

const STATUS_LABELS: Record<CandidateResultRowDTO['status'], string> = {
  in_progress: '进行中',
  submitted: '已交卷',
}

const query = computed<ResultsQuery>(() => ({
  page: page.value,
  name: appliedName.value || undefined,
  passed: passedFilter.value || undefined,
  manual: manualFilter.value || undefined,
}))
</script>

<template>
  <section class="results">
    <PageHeader
      :title="exam?.title ? `${exam.title} · 成绩汇总` : '成绩汇总'"
      :description="exam ? `${formatExamWindow(exam.startsAt, exam.endsAt, exam.timeZone)}（${exam.timeZone}） · ${REVEAL_POLICY_LABELS[exam.answerRevealPolicy]}` : ''"
      :back-to="`/admin/exams/${examId}`"
      back-text="返回场次详情"
    >
      <template #actions>
        <NuxtLink v-if="exam" :to="`/admin/exams/${examId}/blank-corrections`"><el-button>填空答案纠错</el-button></NuxtLink>
        <el-button type="primary" :loading="exporting" :disabled="!exam" @click="exportExcel">导出 Excel</el-button>
        <el-button :loading="pending" @click="refresh()">刷新</el-button>
      </template>
    </PageHeader>

    <StatePanel
      v-if="error"
      :state="forbidden ? 'forbidden' : 'error'"
      :title="forbidden ? '需要管理员权限' : '加载成绩汇总失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : '/admin/exams'"
      :action-text="forbidden ? '重新登录' : '返回场次列表'"
      @retry="refresh()"
    />

    <StatePanel v-else-if="pending && !data" state="loading" title="正在统计数据…" :loading-rows="6" />

    <template v-else-if="data && summary">
      <el-alert v-if="exportError" type="error" :closable="false" show-icon :title="exportError" class="results__alert" />

      <div class="results__stats">
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">参与答卷</p>
          <p class="results__stat-value zj-tabular">{{ summary.totalAttempts }}</p>
          <p class="zj-muted results__stat-hint">含进行中与已交卷（无应考/缺考概念）</p>
        </el-card>
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">进行中</p>
          <p class="results__stat-value zj-tabular">{{ summary.inProgressCount }}</p>
          <p class="zj-muted results__stat-hint">未计入分数统计</p>
        </el-card>
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">已交卷</p>
          <p class="results__stat-value zj-tabular">{{ summary.submittedCount }}</p>
          <p class="zj-muted results__stat-hint">分数统计样本</p>
        </el-card>
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">平均分</p>
          <p class="results__stat-value zj-tabular">{{ scoreText(summary.averageScoreUnits) }}</p>
          <p class="zj-muted results__stat-hint">满分 100</p>
        </el-card>
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">最高分</p>
          <p class="results__stat-value zj-tabular">{{ scoreText(summary.highestScoreUnits) }}</p>
          <p class="zj-muted results__stat-hint">已交卷中最高</p>
        </el-card>
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">最低分</p>
          <p class="results__stat-value zj-tabular">{{ scoreText(summary.lowestScoreUnits) }}</p>
          <p class="zj-muted results__stat-hint">已交卷中最低</p>
        </el-card>
        <el-card shadow="never" class="results__stat">
          <p class="results__stat-label zj-muted">及格率</p>
          <p class="results__stat-value zj-tabular">{{ rateText(summary.passRate) }}</p>
          <p class="zj-muted results__stat-hint">≥ {{ formatScoreUnits(PASS_SCORE_UNITS) }} 分视为及格</p>
        </el-card>
      </div>

      <p class="zj-muted results__caption">基于 {{ summary.submittedCount }} 份已交卷答卷；无数据的指标显示「—」。</p>

      <el-card shadow="never" class="results__filters">
        <div class="results__filter-row">
          <el-input
            v-model="nameFilter"
            placeholder="按姓名筛选"
            clearable
            class="results__name"
            @keyup.enter="applyFilters"
            @clear="applyFilters"
          />
          <el-select v-model="passedFilter" class="results__select" placeholder="及格情况">
            <el-option label="全部" value="" />
            <el-option label="及格" value="true" />
            <el-option label="不及格" value="false" />
          </el-select>
          <el-select v-model="manualFilter" class="results__select" placeholder="人工复核">
            <el-option label="全部" value="" />
            <el-option label="仅看人工复核" value="true" />
            <el-option label="未复核" value="false" />
          </el-select>
          <el-button type="primary" plain @click="applyFilters">查询</el-button>
          <el-button text @click="resetFilters">重置</el-button>
        </div>
      </el-card>

      <el-card shadow="never" class="results__table-card">
        <template #header>
          <div class="results__card-head">
            <span>考生答卷</span>
            <span class="zj-muted">共 {{ data.total }} 条 · 每页 {{ data.pageSize || DEFAULT_PAGE_SIZE }}</span>
          </div>
        </template>

        <el-empty v-if="rows.length === 0" :description="appliedName || passedFilter || manualFilter ? '当前筛选条件下没有答卷' : '还没有考生开始作答'" />

        <template v-else>
          <el-table :data="rows" row-key="attemptId" @row-click="openAttempt">
            <el-table-column prop="name" label="姓名" min-width="120" />
            <el-table-column label="状态" width="100">
              <template #default="{ row }">
                <el-tag :type="row.status === 'submitted' ? 'success' : 'warning'" effect="plain" size="small">
                  {{ STATUS_LABELS[row.status as CandidateResultRowDTO['status']] }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="开始时间" width="170">
              <template #default="{ row }">
                <span class="zj-tabular">{{ formatDateTimeSeconds(row.startedAt, timeZone) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="交卷时间" width="170">
              <template #default="{ row }">
                <span class="zj-tabular">{{ row.submittedAt ? formatDateTimeSeconds(row.submittedAt, timeZone) : '—' }}</span>
              </template>
            </el-table-column>
            <el-table-column label="用时" width="110" align="right">
              <template #default="{ row }">
                <span class="zj-tabular">{{ row.durationMs === null ? '进行中' : formatDuration(row.durationMs) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="总分" width="100" align="right">
              <template #default="{ row }">
                <span class="zj-tabular">{{ scoreText(row.totalScoreUnits) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="是否及格" width="100">
              <template #default="{ row }">
                <span v-if="row.passed === null" class="zj-muted">—</span>
                <el-tag v-else :type="row.passed ? 'success' : 'danger'" effect="plain" size="small">
                  {{ row.passed ? '及格' : '不及格' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="人工复核" width="110">
              <template #default="{ row }">
                <el-tag v-if="row.manualReviewed" type="warning" effect="plain" size="small">已复核</el-tag>
                <span v-else class="zj-muted">—</span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="120" align="right">
              <template #default="{ row }">
                <el-button link type="primary" @click.stop="openAttempt(row)">查看答卷</el-button>
              </template>
            </el-table-column>
          </el-table>

          <div class="results__pager">
            <el-pagination
              background
              layout="prev, pager, next, total"
              :current-page="data.page"
              :page-size="data.pageSize"
              :total="data.total"
              @current-change="(value: number) => (page = value)"
            />
          </div>
        </template>
      </el-card>

      <el-card shadow="never" class="results__table-card">
        <template #header>
          <div class="results__card-head">
            <span>逐题表现</span>
            <span class="zj-muted">样本数 = 已交卷答卷数</span>
          </div>
        </template>

        <el-empty v-if="summary.questionStats.length === 0" description="还没有可统计的题目" />

        <el-table v-else :data="summary.questionStats" row-key="questionId">
          <el-table-column label="题号" width="70" align="center">
            <template #default="{ row }"><span class="zj-tabular">{{ row.position }}</span></template>
          </el-table-column>
          <el-table-column label="题型" width="100">
            <template #default="{ row }">
              {{ QUESTION_TYPE_LABELS[row.type as keyof typeof QUESTION_TYPE_LABELS] ?? row.type }}
            </template>
          </el-table-column>
          <el-table-column label="题干" min-width="240">
            <template #default="{ row }">
              <span class="results__stem">{{ formatQuestionStem(row.stem, row.type) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="满分" width="80" align="right">
            <template #default="{ row }"><span class="zj-tabular">{{ formatScoreUnits(row.maxScoreUnits) }}</span></template>
          </el-table-column>
          <el-table-column label="满分人数" width="100" align="right">
            <template #default="{ row }"><span class="zj-tabular">{{ row.correctCount }}</span></template>
          </el-table-column>
          <el-table-column label="部分得分" width="100" align="right">
            <template #default="{ row }"><span class="zj-tabular">{{ row.partialCount }}</span></template>
          </el-table-column>
          <el-table-column label="零分" width="80" align="right">
            <template #default="{ row }"><span class="zj-tabular">{{ row.zeroCount }}</span></template>
          </el-table-column>
          <el-table-column label="正确率" width="90" align="right">
            <template #default="{ row }"><span class="zj-tabular">{{ rateText(row.correctRate) }}</span></template>
          </el-table-column>
          <el-table-column label="样本" width="80" align="right">
            <template #default="{ row }"><span class="zj-tabular">{{ row.sampleSize }}</span></template>
          </el-table-column>
        </el-table>
      </el-card>

      <p class="zj-muted results__foot">
        导出跟随当前筛选（{{ appliedName || '全部姓名' }} / {{
          passedFilter === '' ? '全部及格情况' : passedFilter === 'true' ? '仅及格' : '仅不及格'
        }} / {{ manualFilter === '' ? '全部复核状态' : manualFilter === 'true' ? '仅人工复核' : '未复核' }}）；
        时间按场次时区 {{ timeZone }} 输出。
      </p>
    </template>
  </section>
</template>

<style scoped>
.results__alert {
  margin-bottom: 12px;
}

.results__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 12px;
}

.results__stat :deep(.el-card__body) {
  padding: 14px 16px;
}

.results__stat-label {
  margin: 0;
  font-size: 14px;
}

.results__stat-value {
  margin: 4px 0 2px;
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
}

.results__stat-hint {
  margin: 0;
  font-size: 12px;
}

.results__caption {
  margin: 10px 0 16px;
  font-size: 13px;
}

.results__filters {
  margin-bottom: 16px;
}

.results__filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.results__name {
  max-width: 220px;
}

.results__select {
  width: 160px;
}

.results__table-card {
  margin-bottom: 16px;
}

.results__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
}

.results__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 14px;
}

.results__stem {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.results__foot {
  font-size: 13px;
}
</style>
