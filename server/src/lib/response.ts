/**
 * 统一响应包装 helper
 *
 * 两种使用方式：
 * 1. 路由内手动 return success(data) / fail(code, message)
 * 2. 全局 onSend 钩子自动包装未包装的响应（检测 `code` 字段）
 */

import type { ErrorCodeValue } from './error-codes.js'

export interface ApiResponse<T = unknown> {
  code: number
  data: T | null
  message: string
}

export function success<T>(data: T, message = ''): ApiResponse<T> {
  return { code: 0, data, message }
}

export function fail(code: ErrorCodeValue, data: unknown = null, message = ''): ApiResponse {
  return { code, data, message }
}

/**
 * 检测响应是否已包装（含 `code` 字段且为数字）
 */
export function isWrapped(payload: unknown): payload is ApiResponse {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'code' in payload &&
    typeof (payload as ApiResponse).code === 'number'
  )
}