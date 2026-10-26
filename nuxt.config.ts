// 知卷 Nuxt 配置：全局只有一份，前后端两位实现者都不得改动其中的业务常量（见 docs/impl-contract.md §2）
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',

  // Element Plus 官方 Nuxt 集成：按需自动引入组件与样式
  modules: ['@element-plus/nuxt'],

  elementPlus: {
    // 使用中文语言包，组件文案（分页、上传、日期选择等）与产品一致
    importStyle: 'css',
  },

  css: ['~/assets/styles/main.css'],

  devtools: { enabled: false },

  devServer: {
    port: 4310,
  },

  app: {
    head: {
      htmlAttrs: { lang: 'zh-CN' },
      title: '知卷',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'robots', content: 'noindex, nofollow' },
      ],
    },
  },

  typescript: {
    strict: true,
    typeCheck: false,
  },

  nitro: {
    // 出题任务、截止检查等后台逻辑都在同一个 Node 进程内，不拆服务
    experimental: {
      asyncContext: true,
    },
  },

  runtimeConfig: {
    // 管理员名单：完整字符串匹配（NFC 规范化后）。可用环境变量 NUXT_ADMIN_NAMES 覆盖，值为 JSON 数组字符串
    adminNames: ['管理员'],
    // 私有数据目录（数据库 + 上传资料），相对路径以进程工作目录为基准；可用 NUXT_DATA_DIR 覆盖
    dataDir: 'data',
    // 会话 Cookie 名与有效期（天），见 docs/impl-contract.md §4
    sessionCookieName: 'zj_session',
    sessionTtlDays: 7,
    public: {},
  },
})
