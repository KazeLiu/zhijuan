/** 身份与会话（docs/impl-contract.md §4） */
import type { EpochMs, Role } from './common'

export interface LoginRequest {
  /** 姓名原文；服务端 NFC 规范化 + 去首尾空白后使用 */
  name: string
}

export interface SessionDTO {
  authenticated: boolean
  /** 规范化后的姓名；未登录为 null */
  name: string | null
  role: Role | null
  serverNow: EpochMs
}

export interface LoginResultDTO {
  authenticated: true
  name: string
  role: Role
  landing: string
  serverNow: EpochMs
}

export interface LogoutResultDTO {
  ok: true
}
