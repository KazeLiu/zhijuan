import { useDb } from '../../../../utils/db'
import { failFrom, ok } from '../../../../utils/respond'
import { readParam } from '../../../../utils/params'
import { readExpectedVersion, readJsonObject } from '../../../../utils/validate'
import { requireAdmin } from '../../../../services/session'
import { changeBankState, getBankItem } from '../../../../services/question-bank'
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    const admin = requireAdmin(event, now)
    const id = readParam(event, 'itemId')
    const version = readExpectedVersion(await readJsonObject(event))
    const db = useDb()
    changeBankState(db, id, version, 'approve', admin.name, now)
    return ok(event, getBankItem(db, id))
  } catch (error) { return failFrom(event, error) }
})
