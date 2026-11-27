<template>
  <div class="zj-shell">
    <header class="zj-header">
      <NuxtLink to="/" class="zj-brand">知卷</NuxtLink>
      <p class="zj-tagline">AI 出题 · 在线答题</p>
      <div class="zj-nav">
        <slot name="nav" />
      </div>
    </header>
    <main class="zj-main">
      <slot />
    </main>
  </div>
</template>

<style scoped>
.zj-shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

.zj-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px var(--zj-page-padding);
  min-height: 64px;
  background: #fff;
  border-bottom: 1px solid var(--zj-border);
}

.zj-brand {
  font-size: 20px;
  font-weight: 600;
  color: var(--zj-primary);
  text-decoration: none;
  letter-spacing: 0.04em;
}

.zj-tagline {
  margin: 0;
  font-size: 14px;
  color: var(--zj-text-muted);
}

.zj-nav {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}

.zj-main {
  flex: 1;
  width: 100%;
  max-width: 1440px;
  margin: 0 auto;
  padding: var(--zj-page-padding);
}

@media (max-width: 480px) {
  .zj-header { gap: 12px; }
  .zj-tagline { font-size: 13px; }
}
</style>
