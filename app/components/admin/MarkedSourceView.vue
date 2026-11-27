<script setup lang="ts">
import type { MarkedSourceRules } from '#shared/types'
defineProps<{ rules: MarkedSourceRules }>()
</script>

<template>
  <div class="marked-source">
    <article v-for="(section, index) in rules.sections" :key="index" class="marked-source__section">
      <div v-if="section.context.length" class="marked-source__context">{{ section.context.join(' / ') }}</div>
      <div class="marked-source__content">
        <el-tag v-if="section.memorize" size="small" effect="plain" type="warning">★ 熟记</el-tag>
        <span>{{ section.text }}</span>
      </div>
    </article>
  </div>
</template>

<style scoped>
.marked-source { display: grid; gap: 16px; padding: 16px; }
.marked-source__context { margin-bottom: 8px; color: var(--zj-text-muted); font-size: 14px; overflow-wrap: anywhere; }
.marked-source__content { display: flex; align-items: flex-start; gap: 8px; }
.marked-source__content .el-tag { flex-shrink: 0; margin-top: 3px; }
.marked-source__content span { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.7; }
</style>
