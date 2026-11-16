<script setup lang="ts">
/**
 * 知识点输入（题库 / 入库对话框共用）：
 * 可自由输入、也可从已有知识点里挑；输入即写回 v-model，失焦不会丢字。
 * 不用 el-select allow-create —— 那种写法只有按回车或点选项才提交，失焦会把刚输入的内容清空。
 */
const model = defineModel<string>({ required: true })

const props = withDefaults(
  defineProps<{ suggestions?: string[]; placeholder?: string }>(),
  { suggestions: () => [], placeholder: '优先选择已有知识点' },
)

function fetchSuggestions(query: string, callback: (items: Array<{ value: string }>) => void): void {
  const keyword = query.trim()
  const pool = props.suggestions ?? []
  const matched = keyword ? pool.filter((point) => point.includes(keyword)) : pool
  callback(matched.slice(0, 30).map((value) => ({ value })))
}
</script>

<template>
  <el-autocomplete
    v-model="model"
    :fetch-suggestions="fetchSuggestions"
    :placeholder="placeholder"
    :trigger-on-focus="true"
    clearable
    class="zj-kp-input"
  />
</template>

<style scoped>
.zj-kp-input {
  width: 100%;
}
</style>
