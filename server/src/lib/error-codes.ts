/**
 * 统一业务错误码常量
 * 范围：1xxx 认证/授权 · 2xxx 参数 · 3xxx 业务 · 4xxx 外部 · 5xxx AI
 */

export const ErrorCode = {
  // 1xxx 认证/授权
  AUTH_MISSING: 1001,
  AUTH_INVALID: 1002,
  AUTH_FORBIDDEN: 1003,
  AUTH_BAD_CREDENTIALS: 1004,
  AUTH_DISABLED: 1005,
  AUTH_REVOKED: 1006, // 改密 / 重置密码后旧 token 失效
  AUTH_WRONG_OLD_PASSWORD: 1007,

  // 2xxx 参数
  VALIDATION_FAIL: 2000,
  INVITE_INVALID: 2001,
  USERNAME_TAKEN: 2002,
  BUSINESS_VALIDATION: 2003,

  // 3xxx 业务
  UNIQUE_CONFLICT: 3001,
  NOT_FOUND: 3002,
  CANNOT_OPERATE_SELF: 3003,

  // 5xxx AI
  AI_PARSE_FAIL: 5001,
  AI_FORMAT_INVALID: 5002,
  AI_CHAT_FAIL: 5003,
} as const

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode]