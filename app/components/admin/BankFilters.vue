<script setup lang="ts">
import type { BankFilters, LibraryFileDTO } from '#shared/types'
import { DIFFICULTY_LABELS } from '#shared/types'
const props = defineProps<{ modelValue: BankFilters; knowledgePoints: string[]; files: LibraryFileDTO[] }>()
const emit = defineEmits<{ 'update:modelValue': [filters: BankFilters] }>()
function update(patch: Partial<BankFilters>) { emit('update:modelValue', { ...props.modelValue, ...patch }) }
</script>
<template>
  <div class="bank-filters">
    <el-select :model-value="modelValue.knowledgePoints ?? []" multiple filterable collapse-tags collapse-tags-tooltip placeholder="全部知识点" aria-label="知识点筛选"
      @update:model-value="update({ knowledgePoints: $event })">
      <el-option v-for="point in knowledgePoints" :key="point" :label="point" :value="point" />
    </el-select>
    <el-select :model-value="modelValue.difficulty ?? ''" aria-label="难度筛选" @update:model-value="update({ difficulty: $event || undefined })">
      <el-option label="全部难度" value="" /><el-option v-for="(label, difficulty) in DIFFICULTY_LABELS" :key="difficulty" :label="label" :value="difficulty" />
    </el-select>
    <el-select :model-value="modelValue.libraryFileIds ?? []" multiple filterable collapse-tags collapse-tags-tooltip placeholder="全部来源资料" aria-label="来源资料筛选"
      @update:model-value="update({ libraryFileIds: $event })">
      <el-option v-for="file in files" :key="file.id" :label="file.originalName" :value="file.id" />
    </el-select>
  </div>
</template>
<style scoped>
.bank-filters { display: grid; grid-template-columns: 1.3fr 1fr 1.5fr; gap: 12px; }
@media(max-width: 650px) { .bank-filters { grid-template-columns: 1fr; } }
</style>
