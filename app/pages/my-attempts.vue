<script setup lang="ts">
/** 我的记录（契约 §9.1）：每页 20；已交卷进结果页，进行中进作答页 */
import type { MyAttemptRowDTO, Paginated } from '#shared/types'
import { DEFAULT_PAGE_SIZE } from '#shared/constants'

useHead({ title: '知卷 · 我的记录' })

const page = ref(1)

const { data, error, pending, refresh } = await useAsyncData<Paginated<MyAttemptRowDTO>>(
  'zj-my-attempts',
  () =>
    apiFetch<Paginated<MyAttemptRowDTO>>('/api/me/attempts', {
      query: { page: page.value },
      silent: true,
    }),
  { server: true, watch: [page] },
)

const rows = computed(() => data.value?.items ?? [])

/** el-table 插槽 row 为 DefaultRow，统一在脚本内收窄类型 */
function openRow(record: unknown): void {
  const row = record as MyAttemptRowDTO
  const target =
    row.status === 'submitted' ? `/attempts/${row.attemptId}/result` : `/exams/${row.examId}/attempt`
  void navigateTo(target)
}

function handlePageChange(next: number): void {
  page.value = next
}
</script>

<template>
  <section class="records">
    <PageHeader
      title="我的记录"
      description="每场考试只能作答一次；进行中的记录可以继续作答，已交卷的记录可查看成绩。"
      back-to="/"
      back-text="返回入口"
    >
      <template #actions>
        <el-button :loading="pending" @click="refresh()">刷新</el-button>
      </template>
    </PageHeader>

    <StatePanel
      v-if="error"
      state="error"
      title="加载记录失败"
      :description="describeApiError(error, '请稍后重试')"
      @retry="refresh()"
    />

    <StatePanel v-else-if="pending && !data" state="loading" :loading-rows="5" />

    <StatePanel
      v-else-if="rows.length === 0"
      state="empty"
      title="还没有答题记录"
      description="有场次开放时，进入入口页即可开始答题。"
    >
      <template #default />
    </StatePanel>

    <template v-else>
      <el-table :data="rows" class="records__table" row-key="attemptId" @row-click="openRow">
        <el-table-column label="考试" min-width="200">
          <template #default="{ row }">
            <div class="records__title">{{ row.examTitle }}</div>
            <div class="records__sub zj-muted">
              {{ formatDateTime(row.examStartsAt, row.examTimeZone) }} —
              {{ formatDateTime(row.examEndsAt, row.examTimeZone) }}
            </div>
          </template>
        </el-table-column>

        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="row.status === 'submitted' ? 'success' : 'warning'" effect="plain" size="small">
              {{ row.status === 'submitted' ? '已交卷' : '进行中' }}
            </el-tag>
          </template>
        </el-table-column>

        <el-table-column label="开始时间" width="180">
          <template #default="{ row }">
            <span class="zj-tabular">{{ formatDateTimeSeconds(row.startedAt, row.examTimeZone) }}</span>
          </template>
        </el-table-column>

        <el-table-column label="交卷时间" width="180">
          <template #default="{ row }">
            <span v-if="row.submittedAt" class="zj-tabular">
              {{ formatDateTimeSeconds(row.submittedAt, row.examTimeZone) }}
            </span>
            <span v-else class="zj-muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="得分" width="110" align="right">
          <template #default="{ row }">
            <span v-if="row.totalScoreUnits !== null" class="zj-tabular">{{ formatScoreUnits(row.totalScoreUnits) }}</span>
            <span v-else class="zj-muted">—</span>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="130" align="right">
          <template #default="{ row }">
            <el-button link type="primary" @click.stop="openRow(row)">
              {{ row.status === 'submitted' ? '查看成绩' : '继续答题' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <div class="records__pager">
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
  </section>
</template>

<style scoped>
.records {
  max-width: 1040px;
  margin: 0 auto;
}

.records__table {
  cursor: pointer;
}

.records__title {
  font-weight: 600;
}

.records__sub {
  font-size: 13px;
}

.records__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}
</style>
