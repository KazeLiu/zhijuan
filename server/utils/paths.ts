import { mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * 私有数据目录约定（docs/impl-contract.md §3）：
 *   <dataDir>/db/zhijuan.sqlite          主库（同目录出现 -wal/-shm 属正常）
 *   <dataDir>/uploads/<examId>/<docId>.<ext>  上传资料原件
 * dataDir 由 runtimeConfig.dataDir 决定（相对路径以进程工作目录为基准），
 * 默认 data/，独立于 .output 构建产物，重新构建不会清库。
 */
export function getDataDir(): string {
  const configured = useRuntimeConfig().dataDir || 'data'
  return resolve(process.cwd(), configured)
}

export function getDbDir(): string {
  return join(getDataDir(), 'db')
}

export function getDbFilePath(): string {
  return join(getDbDir(), 'zhijuan.sqlite')
}

export function getUploadsDir(): string {
  return join(getDataDir(), 'uploads')
}

/** 资料在库中保存的相对路径统一以此为根，读取时用 resolveStoragePath 还原 */
export function getStorageRoot(): string {
  return getDataDir()
}

/** 幂等创建数据目录（启动时调用一次） */
export function ensureDataDirs(): void {
  mkdirSync(getDbDir(), { recursive: true })
  mkdirSync(getUploadsDir(), { recursive: true })
}
