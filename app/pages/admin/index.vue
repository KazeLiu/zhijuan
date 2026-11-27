<script setup lang="ts">
/** 管理端概览（契约 §9.2 / §8.4）：当前场次、下一场、草稿与已发布数量、待重试失败任务 */
import type { AdminOverviewDTO } from '#shared/types'

definePageMeta({ layout: 'admin' })
useHead({ title: '知卷 · 管理概览' })

const { data, error, pending, refresh } = await useAsyncData<AdminOverviewDTO>(
  'zj-admin-overview',
  () => apiFetch<AdminOverviewDTO>('/api/admin/overview', { silent: true }),
  { server: false },
)

const forbidden = computed(() => error.value instanceof ApiClientError && error.value.code === 'FORBIDDEN')
const current = computed(() => data.value?.currentExam ?? null)
const next = computed(() => data.value?.nextExam ?? null)

function examTimeZoneFallback(): string {
  return data.value?.serverTimeZone ?? browserTimeZone()
}
</script>

<template>
  <section class="overview">
    <PageHeader title="概览" description="当前开放的场次、下一场安排与待处理事项。">
      <template #actions>
        <NuxtLink to="/admin/exams">
          <el-button type="primary">管理考试场次</el-button>
        </NuxtLink>
        <el-button :loading="pending" @click="refresh()">刷新</el-button>
      </template>
    </PageHeader>

    <StatePanel
      v-if="error"
      :state="forbidden ? 'forbidden' : 'error'"
      :title="forbidden ? '需要管理员权限' : '加载概览失败'"
      :description="forbidden ? '当前登录身份不是管理员，请用管理员姓名登录。' : describeApiError(error, '请稍后重试')"
      :action-to="forbidden ? '/' : undefined"
      :action-text="forbidden ? '重新登录' : ''"
      @retry="refresh()"
    />

    <StatePanel v-else-if="!data" state="loading" title="正在加载概览…" :loading-rows="5" />

    <template v-else-if="data">
      <div class="overview__stats">
        <el-card shadow="never" class="overview__stat">
          <p class="overview__stat-label zj-muted">草稿场次</p>
          <p class="overview__stat-value zj-tabular">{{ data.draftCount }}</p>
          <NuxtLink to="/admin/exams?status=draft" class="overview__stat-link">查看草稿</NuxtLink>
        </el-card>
        <el-card shadow="never" class="overview__stat">
          <p class="overview__stat-label zj-muted">已发布场次</p>
          <p class="overview__stat-value zj-tabular">{{ data.publishedCount }}</p>
          <NuxtLink to="/admin/exams?status=published" class="overview__stat-link">查看已发布</NuxtLink>
        </el-card>
        <el-card shadow="never" class="overview__stat">
          <p class="overview__stat-label zj-muted">失败待重试任务</p>
          <p class="overview__stat-value zj-tabular" :class="{ 'overview__stat-value--warn': data.failedJobCount > 0 }">
            {{ data.failedJobCount }}
          </p>
          <span class="zj-muted overview__stat-hint">在对应场次详情页点「重试」</span>
        </el-card>
      </div>

      <el-card shadow="never" class="overview__card">
        <template #header>
          <div class="overview__card-head">
            <span>当前开放的场次</span>
            <span class="zj-muted">服务器时区 {{ data.serverTimeZone }}</span>
          </div>
        </template>

        <div v-if="current" class="overview__exam">
          <div class="overview__exam-main">
            <h3 class="overview__exam-title">{{ current.title }}</h3>
            <p class="zj-muted overview__exam-meta">
              {{ formatDateTime(current.startsAt, current.timeZone) }} —
              {{ formatDateTime(current.endsAt, current.timeZone) }}（{{ current.timeZone }}）
            </p>
            <p class="zj-muted overview__exam-meta">共 {{ current.questionCount }} 题</p>
          </div>
          <div class="overview__exam-counts">
            <div><span class="zj-muted">开始</span><strong class="zj-tabular">{{ current.startedCount }}</strong></div>
            <div><span class="zj-muted">进行中</span><strong class="zj-tabular">{{ current.inProgressCount }}</strong></div>
            <div><span class="zj-muted">已交卷</span><strong class="zj-tabular">{{ current.submittedCount }}</strong></div>
          </div>
          <div class="overview__exam-actions">
            <NuxtLink :to="`/admin/exams/${current.id}/results`">
              <el-button type="primary">查看成绩汇总</el-button>
            </NuxtLink>
            <NuxtLink :to="`/admin/exams/${current.id}`">
              <el-button>场次详情</el-button>
            </NuxtLink>
          </div>
        </div>
        <el-empty v-else description="当前没有开放中的场次" />
      </el-card>

      <el-card shadow="never" class="overview__card">
        <template #header>
          <div class="overview__card-head"><span>下一场安排</span></div>
        </template>

        <div v-if="next" class="overview__exam">
          <div class="overview__exam-main">
            <h3 class="overview__exam-title">{{ next.title }}</h3>
            <p class="zj-muted overview__exam-meta">
              {{ formatDateTime(next.startsAt, next.timeZone) }} —
              {{ formatDateTime(next.endsAt, next.timeZone) }}（{{ next.timeZone }}）
            </p>
            <p class="zj-muted overview__exam-meta">
              {{ formatRelativeToNow(next.startsAt, data.serverNow) }}开始 · 共 {{ next.questionCount }} 题
            </p>
          </div>
          <div class="overview__exam-actions">
            <NuxtLink :to="`/admin/exams/${next.id}`">
              <el-button>场次详情</el-button>
            </NuxtLink>
          </div>
        </div>
        <el-empty v-else description="暂无已发布的未来场次">
          <p class="zj-muted overview__empty-hint">
            创建草稿并通过发布预检后，这里会显示下一场；时区按
            {{ data.serverTimeZone }} 计算。
          </p>
        </el-empty>
      </el-card>
    </template>
  </section>
</template>

<style scoped>
.overview__stats {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: var(--zj-section-gap);
}

.overview__stat :deep(.el-card__body) {
  padding: 20px;
}

.overview__stat-label {
  margin: 0;
  font-size: 14px;
}

.overview__stat-value {
  margin: 8px 0;
  font-size: 32px;
  font-weight: 500;
  line-height: 1.1;
}

.overview__stat-value--warn {
  color: var(--zj-danger);
}

.overview__stat-link {
  font-size: 14px;
}

.overview__stat-hint {
  font-size: 13px;
}

.overview__card {
  margin-bottom: var(--zj-section-gap);
}

.overview__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-weight: 600;
}

.overview__exam {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px 24px;
}

.overview__exam-main {
  flex: 1 1 320px;
  min-width: 0;
}

.overview__exam-title {
  margin: 0;
  font-size: 18px;
}

.overview__exam-meta {
  margin: 4px 0 0;
  font-size: 14px;
}

.overview__exam-counts {
  display: flex;
  gap: 20px;
}

.overview__exam-counts div {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 14px;
}

.overview__exam-counts strong {
  font-size: 20px;
}

.overview__exam-actions {
  display: flex;
  gap: 12px;
  max-width: 100%;
  overflow-x: auto;
}

.overview__empty-hint {
  margin: 0;
  font-size: 14px;
  max-width: 520px;
}
@media (max-width: 600px) {
  .overview__stats { grid-template-columns: 1fr; }
  .overview__stat :deep(.el-card__body) { padding: 16px; }
}
</style>
