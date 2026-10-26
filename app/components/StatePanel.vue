<script setup lang="ts">
/**
 * 统一的三态占位（契约 §10.1）：loading / empty / error / forbidden。
 * 页面必须显式处理这些状态，不得用假数据填充。
 */
type PanelState = 'loading' | 'empty' | 'error' | 'forbidden'

interface Props {
  state: PanelState
  title?: string
  description?: string
  retryText?: string
  actionText?: string
  actionTo?: string
  loadingRows?: number
}

const props = withDefaults(defineProps<Props>(), {
  title: '',
  description: '',
  retryText: '重试',
  actionText: '',
  actionTo: '',
  loadingRows: 4,
})

const emit = defineEmits<{ retry: []; action: [] }>()

const DEFAULT_TITLES: Record<PanelState, string> = {
  loading: '正在加载…',
  empty: '暂无数据',
  error: '加载失败',
  forbidden: '需要管理员权限',
}

const resolvedTitle = computed(() => props.title || DEFAULT_TITLES[props.state])
const resolvedDescription = computed(() => {
  if (props.description) return props.description
  if (props.state === 'forbidden') return '当前登录身份没有管理端权限，请用管理员姓名的身份重新登录。'
  return ''
})
</script>

<template>
  <section class="state-panel" :class="`state-panel--${state}`">
    <div v-if="state === 'loading'" class="state-panel__loading" aria-busy="true" aria-live="polite">
      <p class="state-panel__loading-text zj-muted">{{ resolvedTitle }}</p>
      <el-skeleton :rows="loadingRows" animated />
    </div>

    <el-result
      v-else-if="state === 'error'"
      icon="warning"
      :title="resolvedTitle"
      :sub-title="resolvedDescription"
    >
      <template #extra>
        <el-button type="primary" @click="emit('retry')">{{ retryText }}</el-button>
        <NuxtLink v-if="actionTo" :to="actionTo">
          <el-button text @click="emit('action')">{{ actionText || '返回' }}</el-button>
        </NuxtLink>
      </template>
    </el-result>

    <el-result
      v-else-if="state === 'forbidden'"
      icon="error"
      :title="resolvedTitle"
      :sub-title="resolvedDescription"
    >
      <template #extra>
        <NuxtLink v-if="actionTo" :to="actionTo">
          <el-button type="primary" @click="emit('action')">{{ actionText || '返回入口' }}</el-button>
        </NuxtLink>
      </template>
    </el-result>

    <el-empty v-else :description="resolvedTitle">
      <p v-if="resolvedDescription" class="state-panel__desc zj-muted">{{ resolvedDescription }}</p>
      <el-button v-if="actionText" type="primary" @click="emit('action')">{{ actionText }}</el-button>
    </el-empty>
  </section>
</template>

<style scoped>
.state-panel {
  padding: 8px 0;
}

.state-panel__loading-text {
  margin: 0 0 12px;
  font-size: 15px;
}

.state-panel__desc {
  margin: 0 0 16px;
  max-width: 560px;
}
</style>
