<script setup lang="ts">
/** 个人错题集（契约 §8.3 5）：本人已公开、最终未满分的题目，按每次考试题目逐条保留 */
import type { MyMistakeQuestionDTO, Paginated, QuestionType } from '#shared/types'
import { QUESTION_TYPE_LABELS } from '#shared/types'
import { DEFAULT_PAGE_SIZE } from '#shared/constants'

useHead({ title: '知卷 · 我的错题' })

const page = ref(1)
const filters = reactive({ query: '', type: '' as QuestionType | '' })
const applied = ref({ ...filters })

const { data, error, pending, refresh } = await useAsyncData<Paginated<MyMistakeQuestionDTO>>(
  'zj-my-mistakes',
  () =>
    apiFetch<Paginated<MyMistakeQuestionDTO>>('/api/me/mistakes', {
      query: { page: page.value, query: applied.value.query || undefined, type: applied.value.type || undefined },
      silent: true,
    }),
  { server: true, watch: [page, applied] },
)

const items = computed(() => data.value?.items ?? [])

function search(): void {
  page.value = 1
  applied.value = { ...filters, query: filters.query.trim() }
}

function reset(): void {
  Object.assign(filters, { query: '', type: '' })
  search()
}

/** 数据变化后页码可能越界，回退到最后一页 */
async function reload(): Promise<void> {
  await refresh()
  if (data.value && page.value > data.value.totalPages) page.value = data.value.totalPages
}
</script>

<template>
  <section class="mistakes">
    <PageHeader
      title="我的错题"
      description="仅收录本人已公开答案的未满分题目，含部分得分、零分与未作答。"
      back-to="/my-attempts"
      back-text="我的记录"
    >
      <template #actions>
        <el-button :loading="pending" @click="reload()">刷新</el-button>
      </template>
    </PageHeader>

    <el-card shadow="never" class="mistakes__filters">
      <div class="mistakes__row">
        <el-input
          v-model="filters.query"
          placeholder="搜索题干"
          clearable
          aria-label="题干关键词"
          @keyup.enter="search"
        />
        <el-select v-model="filters.type" aria-label="题型筛选">
          <el-option label="全部题型" value="" />
          <el-option v-for="(label, type) in QUESTION_TYPE_LABELS" :key="type" :label="label" :value="type" />
        </el-select>
      </div>
      <div class="mistakes__controls">
        <el-button type="primary" plain @click="search">查询</el-button>
        <el-button text @click="reset">重置</el-button>
      </div>
    </el-card>

    <StatePanel
      v-if="error"
      state="error"
      title="加载错题失败"
      :description="describeApiError(error, '请稍后重试')"
      @retry="reload()"
    />

    <StatePanel v-else-if="pending && !data" state="loading" :loading-rows="4" />

    <StatePanel
      v-else-if="data && data.total === 0"
      state="empty"
      title="没有符合条件的错题"
      description="换一组筛选条件试试。"
      action-text="清除筛选"
      @action="reset"
    />

    <template v-else>
      <article v-for="item in items" :key="`${item.attemptId}-${item.id}`" class="mk">
        <header class="mk__head">
          <span class="mk__exam">{{ item.examTitle }}</span>
          <span class="zj-muted mk__time">{{ formatDateTimeSeconds(item.submittedAt, item.examTimeZone) }} 交卷</span>
          <span class="mk__position">第 {{ item.position }} 题</span>
          <el-tag size="small" effect="plain">{{ QUESTION_TYPE_LABELS[item.type] }}</el-tag>
          <el-tag v-if="item.manualReviewed" size="small" type="warning" effect="plain">人工复核</el-tag>
          <span class="mk__score zj-tabular">
            {{ formatScoreUnits(item.earnedScoreUnits) }} / {{ formatScoreUnits(item.maxScoreUnits) }} 分
          </span>
        </header>

        <p class="mk__stem">{{ formatQuestionStem(item.stem, item.type) }}</p>

        <ul v-if="item.options.length > 0" class="mk__options">
          <li v-for="option in item.options" :key="option.id">{{ option.id }}. {{ option.text }}</li>
        </ul>

        <dl class="mk__rows">
          <div class="mk__row">
            <dt>我的答案</dt>
            <dd :class="{ 'mk__unanswered': item.unanswered }">{{ describeAnswer(item, item.userAnswer) }}</dd>
          </div>
          <div class="mk__row">
            <dt>正确答案</dt>
            <dd>{{ describeCorrectAnswer(item.type, item.options, item.correctAnswer.optionIds, item.correctAnswer.blanks) }}</dd>
          </div>
          <div v-if="item.manualReviewed" class="mk__row">
            <dt>自动判分</dt>
            <dd>{{ formatScoreUnits(item.autoScoreUnits) }} 分（已人工改为 {{ formatScoreUnits(item.earnedScoreUnits) }} 分）</dd>
          </div>
          <div v-if="item.explanation" class="mk__row">
            <dt>解析</dt>
            <dd class="mk__explanation">{{ item.explanation }}</dd>
          </div>
        </dl>

        <NuxtLink :to="`/attempts/${item.attemptId}/result`" class="mk__link">查看整份成绩</NuxtLink>
      </article>

      <div class="mistakes__pager">
        <el-pagination
          background
          layout="prev, pager, next, total"
          :current-page="data?.page ?? 1"
          :page-size="data?.pageSize ?? DEFAULT_PAGE_SIZE"
          :total="data?.total ?? 0"
          @current-change="page = $event"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.mistakes {
  max-width: 1040px;
  margin: 0 auto;
}

.mistakes__filters {
  margin-bottom: 16px;
}

.mistakes__row {
  display: grid;
  grid-template-columns: 1.3fr 1fr;
  gap: 12px;
  margin-bottom: 12px;
}

.mistakes__controls {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.mistakes__pager {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.mk {
  padding: 14px 16px;
  border: 1px solid var(--zj-border);
  border-left: 3px solid var(--zj-danger);
  border-radius: var(--zj-radius);
  background: var(--zj-danger-weak);
}

.mk + .mk {
  margin-top: 10px;
}

.mk__head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.mk__exam {
  font-weight: 600;
}

.mk__time,
.mk__position {
  font-size: 13px;
}

.mk__score {
  margin-left: auto;
  font-weight: 600;
}

.mk__stem {
  margin: 10px 0 8px;
  line-height: 1.7;
}

.mk__options {
  margin: 0 0 8px;
  padding-left: 18px;
  line-height: 1.8;
  color: var(--zj-text-muted);
}

.mk__rows {
  margin: 0;
}

.mk__row {
  display: flex;
  gap: 12px;
  padding: 6px 0;
}

.mk__row dt {
  flex: 0 0 72px;
  color: var(--zj-text-muted);
}

.mk__row dd {
  margin: 0;
  flex: 1 1 auto;
}

.mk__unanswered {
  color: var(--zj-text-muted);
}

.mk__explanation {
  line-height: 1.7;
}

.mk__link {
  display: inline-block;
  margin-top: 8px;
  color: var(--zj-primary);
  font-size: 13px;
}

@media (max-width: 650px) {
  .mistakes__row {
    grid-template-columns: 1fr;
  }

  .mk__row {
    flex-direction: column;
    gap: 4px;
  }
}
</style>
