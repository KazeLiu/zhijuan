import type { EpochMs } from '../../shared/types/common'

interface HealthData {
  ok: true
  serverNow: EpochMs
  schemaVersion: number
}

/** 存活探针：不泄露数据目录、配置或密钥 */
export default defineEventHandler((event): { data: HealthData } => {
  const db = useDb()
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    | { version: number | null }
    | undefined
  return ok<HealthData>(event, {
    ok: true,
    serverNow: Date.now(),
    schemaVersion: row?.version ?? 0,
  })
})
