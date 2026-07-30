/**
 * 记忆路由 - /api/memories
 * AI 全局记忆 CRUD
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'

const createMemorySchema = z.object({
  content: z.string().min(1, '内容不能为空').max(500, '内容不能超过500字'),
  category: z.enum(['preference', 'habit', 'rule', 'context']).default('preference'),
})

const updateMemorySchema = z.object({
  content: z.string().min(1, '内容不能为空').max(500, '内容不能超过500字').optional(),
  is_active: z.union([z.literal(0), z.literal(1)]).optional(),
})

export async function memoryRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)

  // GET /api/memories - 获取所有记忆（含未激活）
  app.get('/api/memories', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    const items = db
      .prepare(
        `SELECT id, content, category, source, source_detail, is_active, created_at, updated_at
         FROM ai_memories
         WHERE user_id = ?
         ORDER BY created_at DESC
         LIMIT 200`,
      )
      .all(userId)

    return { code: 0, data: { items }, message: '' }
  })

  // POST /api/memories - 创建记忆
  app.post('/api/memories', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createMemorySchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const result = db
        .prepare(
          `INSERT INTO ai_memories (user_id, content, category, source)
           VALUES (?, ?, ?, 'manual')`,
        )
        .run(userId, body.content, body.category)

      const memory = db
        .prepare('SELECT * FROM ai_memories WHERE id = ?')
        .get(result.lastInsertRowid)

      return { code: 0, data: memory, message: '记忆已创建' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // PUT /api/memories/:id - 更新记忆
  app.put('/api/memories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateMemorySchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 验证归属
      const existing = db
        .prepare('SELECT id FROM ai_memories WHERE id = ? AND user_id = ?')
        .get(Number(id), userId)

      if (!existing) {
        reply.code(404)
        return { code: 3002, data: null, message: '记忆不存在' }
      }

      // 构建动态更新
      const updates: string[] = ["updated_at = datetime('now')"]
      const values: any[] = []

      if (body.content !== undefined) {
        updates.push('content = ?')
        values.push(body.content)
      }
      if (body.is_active !== undefined) {
        updates.push('is_active = ?')
        values.push(body.is_active)
      }

      values.push(Number(id), userId)

      db.prepare(
        `UPDATE ai_memories SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`,
      ).run(...values)

      const updated = db
        .prepare('SELECT * FROM ai_memories WHERE id = ?')
        .get(Number(id))

      return { code: 0, data: updated, message: '记忆已更新' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/memories/:id - 删除记忆
  app.delete('/api/memories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare('DELETE FROM ai_memories WHERE id = ? AND user_id = ?')
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '记忆不存在' }
    }

    return { code: 0, data: null, message: '记忆已删除' }
  })
}
