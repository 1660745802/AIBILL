/**
 * 认证路由 - /api/auth
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { register, login, getUserById, changePassword, AppError } from '../services/auth.service.js'
import { authMiddleware } from '../middleware/auth.js'

const registerSchema = z.object({
  username: z
    .string()
    .min(3, '用户名至少3个字符')
    .max(20, '用户名最多20个字符')
    .regex(/^[a-zA-Z0-9_]+$/, '用户名只能包含字母、数字和下划线'),
  password: z.string().min(6, '密码至少6个字符').max(50, '密码最多50个字符'),
  invite_code: z.string().min(1, '邀请码不能为空'),
  nickname: z.string().max(20).optional(),
})

const loginSchema = z.object({
  username: z.string().min(1, '用户名不能为空'),
  password: z.string().min(1, '密码不能为空'),
})

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/auth/register
  app.post('/api/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = registerSchema.parse(request.body)
      const result = register(body)
      return { code: 0, data: result, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if (err instanceof AppError) {
        reply.code(400)
        return { code: err.code, data: null, message: err.message }
      }
      throw err
    }
  })

  // POST /api/auth/login
  app.post('/api/auth/login', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = loginSchema.parse(request.body)
      const result = login(body)
      return { code: 0, data: result, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if (err instanceof AppError) {
        reply.code(401)
        return { code: err.code, data: null, message: err.message }
      }
      throw err
    }
  })

  // GET /api/auth/me
  app.get(
    '/api/auth/me',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = getUserById(request.user!.userId)
      if (!user) {
        reply.code(401)
        return { code: 1006, data: null, message: '用户不存在' }
      }
      return { code: 0, data: { user }, message: '' }
    },
  )

  // PUT /api/auth/password - 修改密码
  const changePasswordSchema = z.object({
    old_password: z.string().min(1, '请输入当前密码'),
    new_password: z.string().min(6, '新密码至少6个字符').max(50),
  })

  app.put(
    '/api/auth/password',
    { preHandler: authMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const body = changePasswordSchema.parse(request.body)
        const result = changePassword(request.user!.userId, body.old_password, body.new_password)
        if (!result.success) {
          reply.code(400)
          return { code: 1007, data: null, message: result.message }
        }
        return { code: 0, data: null, message: '密码修改成功' }
      } catch (err) {
        if (err instanceof z.ZodError) {
          reply.code(400)
          return { code: 2000, data: null, message: err.errors[0].message }
        }
        throw err
      }
    },
  )
}
