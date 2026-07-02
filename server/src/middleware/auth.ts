/**
 * JWT 认证中间件
 * 解析 Authorization: Bearer <token>，注入 userId/role 到 request
 */
import type { FastifyRequest, FastifyReply } from 'fastify'
import jwt from 'jsonwebtoken'
import { config } from '../config.js'

export interface JwtPayload {
  userId: number
  role: 'admin' | 'user'
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
    request.user = payload
  } catch {
    reply.code(401).send({ code: 1002, data: null, message: '令牌无效或已过期' })
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
  }
}
