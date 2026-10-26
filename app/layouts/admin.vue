<script setup lang="ts">
/**
 * 管理端布局（契约 §9.2）：左侧固定侧栏 + 顶部管理员姓名与登出；窄屏折叠为抽屉。
 * 角色校验以接口 403 为准，这里只展示会话信息与登出入口。
 */
import type { SessionDTO } from '#shared/types'

useHead({ title: '知卷 · 管理端' })

const route = useRoute()
const { session, refresh, logout } = useAuthSession()
const drawerOpen = ref(false)
const mobileNavOpen = ref(false)

const navItems = [
  { path: '/admin', label: '概览' },
  { path: '/admin/exams', label: '考试场次' },
  { path: '/admin/library', label: '资料库' },
  { path: '/admin/question-bank', label: '题库' },
  { path: '/admin/settings', label: '模型设置' },
]

const activePath = computed(() => {
  const path = route.path
  if (path.startsWith('/admin/exams')) return '/admin/exams'
  if (path.startsWith('/admin/library')) return '/admin/library'
  if (path.startsWith('/admin/question-bank')) return '/admin/question-bank'
  if (path.startsWith('/admin/settings')) return '/admin/settings'
  return '/admin'
})

const isLoggedIn = computed(() => session.value?.authenticated === true)
const roleWarning = computed(() => isLoggedIn.value && session.value?.role !== 'admin')

async function handleLogout(): Promise<void> {
  drawerOpen.value = false
  await logout()
  await clearNuxtData()
  await navigateTo('/')
}

function closeDrawer(): void {
  drawerOpen.value = false
}

onMounted(() => {
  if (session.value === null) void refresh()
})

watch(() => route.fullPath, () => {
  drawerOpen.value = false
  mobileNavOpen.value = false
})
</script>

<template>
  <div class="admin-shell">
    <aside class="admin-sidebar">
      <div class="admin-brand">
        <NuxtLink to="/admin" class="admin-brand__link">知卷</NuxtLink>
        <span class="admin-brand__tag">管理端</span>
      </div>
      <el-menu :default-active="activePath" router class="admin-menu">
        <el-menu-item v-for="item in navItems" :key="item.path" :index="item.path">
          {{ item.label }}
        </el-menu-item>
      </el-menu>
      <div class="admin-sidebar__foot zj-muted">AI 出题 · 在线答题</div>
    </aside>

    <div class="admin-body">
      <header class="admin-topbar">
        <el-button class="admin-topbar__burger" text @click="drawerOpen = true">菜单</el-button>
        <div class="admin-topbar__spacer" />
        <span v-if="isLoggedIn" class="admin-topbar__who">
          {{ session?.name }}
          <el-tag size="small" effect="plain">{{ session?.role === 'admin' ? '管理员' : '考生' }}</el-tag>
        </span>
        <span v-else class="admin-topbar__who zj-muted">未登录</span>
        <el-button v-if="isLoggedIn" text @click="handleLogout">退出</el-button>
        <NuxtLink v-else to="/">
          <el-button text>去登录</el-button>
        </NuxtLink>
      </header>

      <el-alert
        v-if="roleWarning"
        type="warning"
        :closable="false"
        show-icon
        class="admin-role-alert"
        title="当前姓名不在管理员名单内，管理接口会返回 403。"
      >
        <template #default>
          <p class="admin-role-alert__body">
            如需管理权限，请用管理员姓名重新登录（管理员名单由部署配置的 <code>ADMIN_NAMES</code> 决定）。
          </p>
          <el-button size="small" @click="handleLogout">重新登录</el-button>
        </template>
      </el-alert>

      <main class="admin-main">
        <slot />
      </main>
    </div>

    <el-drawer v-model="drawerOpen" title="管理菜单" direction="ltr" size="240px">
      <el-menu :default-active="activePath" router @select="closeDrawer">
        <el-menu-item v-for="item in navItems" :key="item.path" :index="item.path">
          {{ item.label }}
        </el-menu-item>
      </el-menu>
      <el-divider />
      <el-button v-if="isLoggedIn" text @click="handleLogout">退出登录</el-button>
    </el-drawer>
  </div>
</template>

<style scoped>
.admin-shell {
  display: flex;
  min-height: 100vh;
  background: var(--zj-bg);
}

.admin-sidebar {
  display: flex;
  flex-direction: column;
  width: 220px;
  flex: 0 0 220px;
  background: #fff;
  border-right: 1px solid var(--zj-border);
  padding: 18px 12px;
  position: sticky;
  top: 0;
  height: 100vh;
}

.admin-brand {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 0 8px 16px;
}

.admin-brand__link {
  font-size: 20px;
  font-weight: 700;
  color: var(--zj-primary);
  text-decoration: none;
  letter-spacing: 0.04em;
}

.admin-brand__tag {
  font-size: 13px;
  color: var(--zj-text-muted);
}

.admin-menu {
  border-right: none;
  flex: 1;
}

.admin-sidebar__foot {
  font-size: 12px;
  padding: 0 8px;
}

.admin-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.admin-topbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px clamp(16px, 3vw, 32px);
  background: #fff;
  border-bottom: 1px solid var(--zj-border);
  min-height: 56px;
}

.admin-topbar__burger {
  display: none;
}

.admin-topbar__spacer {
  flex: 1;
}

.admin-topbar__who {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 15px;
}

.admin-role-alert {
  margin: 16px clamp(16px, 3vw, 32px) 0;
}

.admin-role-alert__body {
  margin: 6px 0 10px;
  font-size: 14px;
}

.admin-main {
  flex: 1;
  width: 100%;
  padding: clamp(16px, 3vw, 32px);
}

@media (max-width: 900px) {
  .admin-sidebar {
    display: none;
  }

  .admin-topbar__burger {
    display: inline-flex;
  }
}
</style>
