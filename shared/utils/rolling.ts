import { DEFAULT_EXAM_TIME_ZONE } from '../constants'
import type { RollingConfig } from '../types/rolling'

export function defaultRollingConfig(): RollingConfig {
  return { enabled: false, title: '每日测试', instructions: '', timeZone: DEFAULT_EXAM_TIME_ZONE,
    startsAtTime: '00:00', endsAtTime: '00:00',
    blueprint: { singleChoice: 10, multipleChoice: 4, trueFalse: 4, fillBlank: 2, difficulty: 'normal', extraPrompt: '' },
    filters: {}, answerRevealPolicy: 'immediate' }
}
