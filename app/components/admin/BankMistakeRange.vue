<script setup lang="ts">
const topN = defineModel<number | undefined>()
defineProps<{ disabled?: boolean }>()
</script>

<template>
  <div class="bank-mistake-range">
    <el-checkbox :model-value="topN !== undefined" :disabled="disabled" @update:model-value="topN = $event ? 50 : undefined">使用错题集</el-checkbox>
    <template v-if="topN !== undefined">
      <span>仅从错误率前</span>
      <el-input-number v-model="topN" :min="1" :precision="0" value-on-clear="min" :disabled="disabled" aria-label="错题集排名范围" />
      <span>道抽题</span>
    </template>
    <NuxtLink to="/admin/mistakes">查看错题集</NuxtLink>
  </div>
</template>

<style scoped>
.bank-mistake-range { display: flex; align-items: center; gap: 10px; margin-top: 12px; }
.bank-mistake-range .el-checkbox { margin-right: 0; }
@media(max-width: 650px) { .bank-mistake-range { flex-wrap: wrap; } }
</style>
