<script setup lang="ts">
/** 场次列表与新建（契约 §9.2 / §8.5 #15、#16） */
import type { ExamAdminDTO, ExamCreateRequest, ExamListRowDTO, Paginated } from '#shared/types'
import { DEFAULT_EXAM_TIME_ZONE, DEFAULT_PAGE_SIZE, MAX_TITLE_CHARS } from '#shared/constants'
import { defaultExamTitle } from '#shared/utils/exam'

definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 考试场次' })

const route = useRoute()

const page = ref(Number(route.query.page ?? 1) || 1)
const status = ref<'draft' | 'published' | ''>((route.query.status as 'draft' | 'published' | undefined) ?? '')
const keyword = ref(String(route.query.keyword ?? ''))
const appliedKeyword = ref(keyword.value)

const { data, error, pending, refresh } = await useAsyncData<Paginated<ExamListRowDTO>>(
  'zj-admin-exams',
  () =>
    apiFetch<Paginated<ExamListRowDTO>>('/api/admin/exams', {
      query: {
        page: page.value,
        status: status.value || undefined,
        keyword: appliedKeyword.value || undefined,
      },
      silent: true,
    }),
  { server: false, watch: [page, status, appliedKeyword] },
)

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')
const rows = computed(() => data.value?.items ?? [])

const createDialog = ref(false)
const creating = ref(false)
const createError = ref('')
const newTitle = ref('')
const newTimeZone = ref(DEFAULT_EXAM_TIME_ZONE)

function applyFilters(): void {
  page.value = 1
  appliedKeyword.value = keyword.value.trim()
}

function resetFilters(): void {
  keyword.value = ''
  appliedKeyword.value = ''
  status.value = ''
  page.value = 1
}

function openCreate(): void {
  createError.value = ''
  newTimeZone.value = DEFAULT_EXAM_TIME_ZONE
  newTitle.value = defaultExamTitle(Date.now())
  createDialog.value = true
}

async function submitCreate(): Promise<void> {
  creating.value = true
  createError.value = ''
  try {
    const payload: ExamCreateRequest = {
      title: newTitle.value.trim() || undefined,
      timeZone: newTimeZone.value || undefined,
    }
    const created = await apiFetch<ExamAdminDTO>('/api/admin/exams', {
      method: 'POST',
      body: payload,
      silent: true,
    })
    createDialog.value = false
    ElMessage.success('已创建草稿，接下来上传资料并出题')
    await navigateTo(`/admin/exams/${created.id}`)
  } catch (error) {
    createError.value = describeApiError(error, '新建场次失败')
  } finally {
    creating.value = false
  }
}

/** el-table 插槽 row 为 DefaultRow，统一在脚本内收窄类型 */
function openRow(record: unknown): void {
  const row = record as ExamListRowDTO
  void navigateTo(`/admin/exams/${row.id}`)
}

function phaseTagType(phase: ExamListRowDTO['phase']) {
  return EXAM_PHASE_TAG_TYPES[phase]
}

function phaseLabel(phase: ExamListRowDTO['phase']): string {
  return EXAM_PHASE_LABELS[phase]
}

function revealPolicyLabel(policy: ExamListRowDTO['answerRevealPolicy']): string {
  return REVEAL_POLICY_LABELS[policy]
}

function handlePageChange(next: number): void {
  page.value = next
}
</script>

<template>
  <section class="exams">
    <PageHeader title="考试场次" description="草稿可编辑资料与题目；发布后按开放时间对考生可见。">
      <template #actions>
        <el-button type="primary" @click="openCreate">新建场次</el-button>
        <el-button :loading="pending" @click="refresh()">刷新</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never" class="exams__filters">
      <div class="exams__filter-row">
        <el-input
          v-model="keyword"
          placeholder="按标题搜索"
          clearable
          class="exams__keyword"
          @keyup.enter="applyFilters"
          @clear="applyFilters"
        />
        <el-select v-model="status" placeholder="全部状态" clearable class="exams__status">
          <el-option label="全部状态" value="" />
          <el-option label="草稿" value="draft" />
          <el-option label="已发布" value="published" />
        </el-select>
        <el-button type="primary" plain @click="applyFilters">查询</el-button>
        <el-button text @click="resetFilters">重置</el-button>
      </div>
    </el-card>

    <StatePanel
      v-if="error"
      :state="forbidden ? 'forbidden' : 'error'"
      :title="forbidden ? '需要管理员权限' : '加载场次失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : undefined"
      :action-text="forbidden ? '重新登录' : ''"
      @retry="refresh()"
    />

    <StatePanel v-else-if="pending && !data" state="loading" :loading-rows="6" />

    <StatePanel
      v-else-if="rows.length === 0"
      state="empty"
      title="还没有场次"
      description="新建一个草稿场次，上传资料后即可让 AI 出题。"
    >
      <template #default>
        <el-button type="primary" @click="openCreate">新建场次</el-button>
      </template>
    </StatePanel>

    <template v-else>
      <el-table :data="rows" class="exams__table" row-key="id" @row-click="openRow">
        <el-table-column label="标题" min-width="220">
          <template #default="{ row }">
            <div class="exams__title">{{ row.title || '未命名考试' }}</div>
            <div class="exams__sub zj-muted">
              {{ formatExamWindow(row.startsAt, row.endsAt, row.timeZone) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="150">
          <template #default="{ row }">
            <div class="exams__tags">
              <el-tag :type="phaseTagType(row.phase)" effect="plain" size="small">
                {{ phaseLabel(row.phase) }}
              </el-tag>
              <el-tag :type="row.status === 'published' ? 'success' : 'info'" effect="plain" size="small">
                {{ row.status === 'published' ? '已发布' : '草稿' }}
              </el-tag>
            </div>
          </template>
        </el-table-column>

        <el-table-column label="公开策略" width="130">
          <template #default="{ row }">{{ revealPolicyLabel(row.answerRevealPolicy) }}</template>
        </el-table-column>

        <el-table-column label="题目" width="80" align="right">
          <template #default="{ row }"><span class="zj-tabular">{{ row.questionCount }}</span></template>
        </el-table-column>

        <el-table-column label="答卷" width="110" align="right">
          <template #default="{ row }">
            <span class="zj-tabular">{{ row.submittedCount }} / {{ row.attemptCount }}</span>
          </template>
        </el-table-column>

        <el-table-column label="更新时间" width="170">
          <template #default="{ row }">
            <span class="zj-tabular zj-muted">{{ formatDateTimeSeconds(row.updatedAt, row.timeZone) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="190" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="openRow(row)">编辑</el-button>
            <NuxtLink :to="`/admin/exams/${row.id}/results`" @click.stop>
              <el-button link type="primary">成绩汇总</el-button>
            </NuxtLink>
          </template>
        </el-table-column>
      </el-table>

      <div class="exams__pager">
        <el-pagination
          background
          layout="prev, pager, next, total"
          :current-page="data?.page ?? 1"
          :page-size="data?.pageSize ?? DEFAULT_PAGE_SIZE"
          :total="data?.total ?? 0"
          @current-change="handlePageChange"
        />
      </div>
    </template>

    <el-dialog v-model="createDialog" title="新建场次" width="min(520px, 92vw)">
      <el-form label-position="top" @submit.prevent="submitCreate">
        <el-form-item label="场次标题">
          <el-input
            v-model="newTitle"
            :maxlength="MAX_TITLE_CHARS"
            show-word-limit
            placeholder="例如：2026 年安全培训随堂测验"
            @keyup.enter="submitCreate"
          />
        </el-form-item>
        <el-form-item label="场次时区">
          <el-select v-model="newTimeZone" class="exams__tz">
            <el-option v-for="zone in COMMON_TIME_ZONES" :key="zone.value" :label="zone.label" :value="zone.value" />
          </el-select>
          <p class="zj-muted exams__hint">
            新场次默认时间 = 该时区今天 00:00 到次日 00:00，创建后可在详情页修改。
          </p>
        </el-form-item>
      </el-form>

      <el-alert v-if="createError" type="error" :closable="false" show-icon :title="createError" />

      <template #footer>
        <el-button @click="createDialog = false">取消</el-button>
        <el-button type="primary" :loading="creating" @click="submitCreate">创建并编辑</el-button>
      </template>
    </el-dialog>
  </section>
</template>

<style scoped>
.exams__filters {
  margin-bottom: 16px;
}

.exams__filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.exams__keyword {
  max-width: 260px;
}

.exams__status {
  width: 160px;
}

.exams__table {
  cursor: pointer;
}

.exams__title {
  font-weight: 600;
}

.exams__sub {
  font-size: 13px;
}

.exams__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.exams__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.exams__tz {
  width: 100%;
}

.exams__hint {
  margin: 6px 0 0;
  font-size: 13px;
}
</style>
