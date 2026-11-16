/**
 * 场次生命周期动作（契约 §3.1）：暂停 / 继续 / 结束考试。
 * 详情页头部与「公开策略与发布」卡片共用同一套可用性判定、二次确认文案与错误文案，
 * 保证两处按钮状态一致。
 */
import type { ComputedRef, Ref } from 'vue'
import type { ExamAdminDTO } from '#shared/types'

interface LifecycleOptions {
  /** 当前场次；为空时所有动作不可用（允许传 computed） */
  exam: Ref<ExamAdminDTO | null | undefined> | ComputedRef<ExamAdminDTO | null | undefined>
  /** 动作成功或服务端状态已变化时重新加载场次 */
  onChanged: () => void | Promise<void>
}

export function useExamLifecycle(options: LifecycleOptions) {
  const { exam, onChanged } = options
  const busy = ref(false)
  const error = ref('')

  const published = computed(() => exam.value?.status === 'published')
  const paused = computed(() => Boolean(exam.value?.pausedAt) && !exam.value?.endedAt)
  const ended = computed(() => Boolean(exam.value?.endedAt))
  /** 暂停：已发布、未暂停、未结束（未开始与开放中都可暂停） */
  const canPause = computed(() => published.value && !paused.value && !ended.value)
  /** 继续：暂停中且未结束 */
  const canResume = computed(() => published.value && paused.value && !ended.value)
  /** 结束：已发布且未结束（未开始 / 开放中 / 暂停中都可结束） */
  const canEnd = computed(() => published.value && !ended.value)

  async function confirmAction(message: string, title: string, type: 'warning' | 'error'): Promise<boolean> {
    try {
      await ElMessageBox.confirm(message, title, {
        type,
        confirmButtonText: title,
        cancelButtonText: '取消',
      })
      return true
    } catch {
      return false
    }
  }

  async function run(
    path: 'pause' | 'resume' | 'end',
    successText: string,
    failureText: string,
  ): Promise<ExamAdminDTO | null> {
    const current = exam.value
    if (!current) return null
    busy.value = true
    error.value = ''
    try {
      const updated = await apiFetch<ExamAdminDTO>(`/api/admin/exams/${current.id}/${path}`, {
        method: 'POST',
        silent: true,
      })
      ElMessage.success(successText)
      await onChanged()
      return updated
    } catch (cause) {
      error.value = describeLifecycleError(cause, failureText)
      ElMessage.error(error.value)
      // 冲突型错误说明服务端状态已被别的窗口改变，刷新让界面回落
      if (
        cause instanceof ApiClientError
        && (cause.code === 'EXAM_ALREADY_PAUSED'
          || cause.code === 'EXAM_NOT_PAUSED'
          || cause.code === 'EXAM_ALREADY_ENDED'
          || cause.code === 'VERSION_CONFLICT')
      ) {
        await onChanged()
      }
      return null
    } finally {
      busy.value = false
    }
  }

  async function pause(): Promise<void> {
    if (!canPause.value) return
    const confirmed = await confirmAction(
      '暂停后考生暂时不能进入作答，进行中的答卷仍可继续作答并提交；需要恢复时点「继续考试」。',
      '暂停考试',
      'warning',
    )
    if (!confirmed) return
    await run('pause', '场次已暂停', '暂停场次失败')
  }

  async function resume(): Promise<void> {
    if (!canResume.value) return
    const confirmed = await confirmAction('继续后考生可在开放时间内重新进入作答。', '继续考试', 'warning')
    if (!confirmed) return
    await run('resume', '场次已继续', '继续场次失败')
  }

  async function end(): Promise<void> {
    if (!canEnd.value) return
    const confirmed = await confirmAction(
      '结束后考生不能再进入，进行中的答卷仍可提交。该操作不可撤销。',
      '结束考试',
      'error',
    )
    if (!confirmed) return
    await run('end', '场次已结束', '结束考试失败')
  }

  return { busy, error, paused, ended, canPause, canResume, canEnd, pause, resume, end }
}
