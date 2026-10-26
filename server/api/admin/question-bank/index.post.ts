import { useDb } from '../../../utils/db'
import { failFrom, ok } from '../../../utils/respond'
import { requireAdmin } from '../../../services/session'
import { readJsonObject } from '../../../utils/validate'
import { createBankItem } from '../../../services/question-bank'
export default defineEventHandler(async (event) => {
  try {
    const now = Date.now()
    requireAdmin(event, now)
    return ok(event, createBankItem(useDb(), await readJsonObject(event), now), 201)
  } catch (error) { return failFrom(event, error) }
})
