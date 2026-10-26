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
  align-items: flex-end;
  gap: 16px;
  margin-bottom: 20px;
}

.page-header__main {
  flex: 1 1 320px;
  min-width: 0;
}

.page-header__back {
  display: inline-block;
  margin-bottom: 6px;
  font-size: 15px;
  text-decoration: none;
}

.page-header__title {
  margin: 0;
  font-size: clamp(22px, 3vw, 28px);
  line-height: 1.3;
  color: var(--zj-text);
}

.page-header__desc {
  margin: 6px 0 0;
  font-size: 15px;
}

.page-header__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
</style>
