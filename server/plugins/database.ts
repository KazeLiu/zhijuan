/**
 * 启动时初始化数据库：创建私有数据目录 → 打开 SQLite → 执行未应用的迁移。
 * 单进程单连接，所有请求共享同一个 DatabaseSync 实例。
 */
export default defineNitroPlugin(() => {
  const db = useDb()
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined
  console.info(`[db] 数据目录 ${getDataDir()}，schema 版本 ${row?.version ?? 0}`)
})
