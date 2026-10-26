<script setup lang="ts">
/** 姓名登录卡片（设计 §6.1、契约 §9.1）：输入姓名即进入，无密码 */
import type { LoginResultDTO } from '#shared/types'
import { MAX_NAME_LENGTH } from '#shared/constants'

const emit = defineEmits<{ 'logged-in': [result: LoginResultDTO] }>()

const { login } = useAuthSession()

const name = ref('')
const submitting = ref(false)
const errorMessage = ref('')
const inputRef = ref<{ focus: () => void } | null>(null)

async function handleSubmit(): Promise<void> {
  if (submitting.value) return
  const trimmed = name.value.trim()
  if (!trimmed) {
    errorMessage.value = '请输入姓名'
    return
  }
  submitting.value = true
  errorMessage.value = ''
  try {
    const result = await login(trimmed)
    emit('logged-in', result)
  } catch (error) {
    errorMessage.value = describeApiError(error, '登录失败，请重试')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  inputRef.value?.focus()
})
</script>

<template>
  <el-card shadow="never" class="login-card">
    <template #header>
      <div class="login-card__header">
        <span>输入姓名进入</span>
        <el-tag type="success" effect="plain" size="small">姓名即身份</el-tag>
      </div>
    </template>

    <p class="login-card__intro">
      本系统不需要密码。姓名用于识别答卷，每场考试每人只能作答一次；交卷前刷新页面会接着当前进度继续。
    </p>

    <el-form label-position="top" @submit.prevent="handleSubmit">
      <el-form-item label="姓名" required>
        <el-input
          ref="inputRef"
          v-model="name"
          :maxlength="MAX_NAME_LENGTH"
          size="large"
          placeholder="请输入你的姓名"
          autocomplete="off"
          clearable
        />
      </el-form-item>

      <el-alert
        v-if="errorMessage"
        :title="errorMessage"
        type="error"
        :closable="false"
        show-icon
        class="login-card__error"
      />

      <el-button
        type="primary"
        size="large"
        class="login-card__submit"
        :loading="submitting"
        native-type="submit"
      >
        进入
      </el-button>
    </el-form>
  </el-card>
</template>

<style scoped>
.login-card {
  max-width: 520px;
  margin: 0 auto;
}

.login-card__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-weight: 600;
  font-size: 17px;
}

.login-card__intro {
  margin: 0 0 18px;
  color: var(--zj-text-muted);
  font-size: 15px;
}

.login-card__error {
  margin-bottom: 14px;
}

.login-card__submit {
  width: 100%;
  min-height: 44px;
  margin-top: 4px;
}
</style>
