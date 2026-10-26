import { DatabaseSync } from 'node:sqlite'
import { migrations } from '../db/migrations'
import { ensureDataDirs, getDbFilePath } from './paths'

/**
 * 单进程单连接（设计 §1.2）。所有写操作必须走事务；禁止在长事务中调用模型。
 * 统一用位置参数 `?` 绑定（避免 node:sqlite 命名参数前缀差异）。
 */
let instance: DatabaseSync | null = null

export function useDb(): DatabaseSync {
  if (!instance) {
    ensureDataDirs()
    const db = new DatabaseSync(getDbFilePath())
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA synchronous = NORMAL')
    runMigrations(db)
    instance = db
  }
  return instance
}

/** 事务包装：回调抛错则整体回滚 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 回滚失败时保留原始错误
    }
    throw error
  }
}

function runMigrations(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `)
  const appliedRows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>
  const applied = new Set(appliedRows.map((row) => row.version))
  const pending = migrations.filter((migration) => !applied.has(migration.version)).sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    db.exec('BEGIN IMMEDIATE')
    try {
      db.exec(migration.sql)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        Date.now(),
      )
      db.exec('COMMIT')
    } catch (error) {
      try {
        db.exec('ROLLBACK')
      } catch {
        // 忽略回滚异常，抛出迁移原始错误
      }
      throw new Error(`迁移 ${migration.version} (${migration.name}) 执行失败：${(error as Error).message}`)
    }
  }
}
