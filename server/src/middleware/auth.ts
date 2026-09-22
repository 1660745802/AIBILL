/**
 * JWT 认证中间件
 * 解析 Authorization: Bearer <token>，注入 userId/role/ver 到 request
 * 校验 token_version：改密/重置密码/禁用用户时使旧 token 立即失效
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'
import { getDb } from '../db/index.js'

export interface JwtPayload {
  userId: number
  role: 'admin' | 'user'
  ver: number
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: JwtPayload
  }
}

/**
 * 认证中间件 - 校验 JWT 并注入 user 信息
 */
export async function authMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers.authorization

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ code: 1001, data: null, message: '未提供认证令牌' })
    return
  }

  const token = authHeader.slice(7)

  try {
    const payload = jwt.verify(token, config.jwtSecret) as JwtPayload
    // 校验用户状态 + token_version（失效控制）
    const row = getDb()
      .prepare(`SELECT is_active, COALESCE(token_version, 0) AS v FROM users WHERE id = ?`)
      .get(payload.userId) as { is_active: number; v: number } | undefined
    if (!row) {
      reply.code(401).send({ code: 1002, data: null, message: '用户不存在' })
      return
    }
    if (!row.is_active) {
      reply.code(401).send({ code: 1005, data: null, message: '账号已被禁用' })
      return
    }
    if (row.v !== (payload.ver ?? 0)) {
      reply.code(401).send({ code: 1006, data: null, message: '令牌已失效（密码已修改或账号已重置）' })
      return
    }
    request.user = payload
  } catch {
    reply.code(401).send({ code: 1002, data: null, message: '令牌无效或已过期' })
    return
  }
}

/**
 * 管理员权限中间件 - 必须在 authMiddleware 之后使用
 */
export async function adminMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.user || request.user.role !== 'admin') {
    reply.code(403).send({ code: 1003, data: null, message: '权限不足，需要管理员角色' })
    return
  }
}
