<script setup lang="ts">
/** 页面标题区：标题 + 说明 + 右侧操作，可带返回链接 */
interface Props {
  title: string
  description?: string
  backTo?: string
  backText?: string
}

const props = withDefaults(defineProps<Props>(), {
  description: '',
  backTo: '',
  backText: '返回',
})
</script>

<template>
  <header class="page-header">
    <div class="page-header__main">
      <NuxtLink v-if="props.backTo" :to="props.backTo" class="page-header__back">← {{ props.backText }}</NuxtLink>
      <h1 class="page-header__title">{{ props.title }}</h1>
      <p v-if="props.description" class="page-header__desc zj-muted">{{ props.description }}</p>
    </div>
    <div v-if="$slots.actions" class="page-header__actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
.page-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 16px;
  margin-bottom: var(--zj-section-gap);
}

.page-header__main {
  flex: 1 1 280px;
  min-width: 0;
}

.page-header__back {
  display: inline-block;
  margin-bottom: 8px;
  font-size: 15px;
  text-decoration: none;
}

.page-header__title {
  margin: 0;
  font-size: clamp(24px, 3vw, 28px);
  line-height: 1.3;
  color: var(--zj-text);
}

.page-header__desc {
  margin: 8px 0 0;
  font-size: 15px;
  max-width: 72ch;
  overflow-wrap: anywhere;
}

.page-header__actions {
  display: flex;
  align-items: center;
  gap: 12px;
  max-width: 100%;
  overflow-x: auto;
  padding: 4px 0;
}

.page-header__actions > :deep(*) { flex-shrink: 0; }
@media (max-width: 768px) {
  .page-header__main { flex-basis: 100%; }
  .page-header__actions { width: 100%; }
}
</style>
