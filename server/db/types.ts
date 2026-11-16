import type { DatabaseSync } from 'node:sqlite'

/**
 * 迁移条目：SQL 内联在 TS 模块里，随 Nitro 产物一起发布。
 * 规则：只追加新版本，不修改已发布版本的 SQL；禁用 DROP TABLE 式的重建式修复。
 */
export interface Migration {
  /** 递增整数，从 1 开始 */
  version: number
  /** 简短说明 */
  name: string
  /** 可包含多条语句，迁移器在事务中整体执行；纯数据清洗时可为空串 */
  sql: string
  /**
   * 存量数据清洗等必须逐行读写的场景：SQL 执行完、同一事务内调用。
   * 抛错会让整个迁移回滚（版本号不会写入 schema_migrations）。
   */
  run?: (db: DatabaseSync) => void
}
