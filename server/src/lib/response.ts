/**
 * 响应体判定 helper
 *
 * app.ts 的全局 onSend 钩子需要区分“已包装”与“未包装”的响应，
 * 以便自动补上 { code, data, message }。
 *
 * 注：错误码常量（1xxx 认证 / 2xxx 参数 / 3xxx 业务 / 5xxx AI）目前
 * 直接写在各路由里，唯一权威表在 docs/API.md §0.3；早期版本的
 * ErrorCode / success() / fail() helper 无任何调用方，已移除。
 */

export interface ApiResponse<T = unknown> {
  code: number
  data: T | null
  message: string
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
