/**
 * 分类路由 - /api/categories
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { authMiddleware } from '../middleware/auth.js'
import { getDb } from '../db/index.js'
import { AppError } from '../services/auth.service.js'

const createCategorySchema = z.object({
  name: z.string().min(1, '分类名称不能为空').max(20, '分类名称最多20个字符'),
  type: z.enum(['expense', 'income'], { message: '类型必须是 expense 或 income' }),
  icon: z.string().max(10).optional(),
  parent_id: z.number().int().positive().optional(),
  sort_order: z.number().int().min(0).optional(),
})

const updateCategorySchema = z.object({
  name: z.string().min(1).max(20).optional(),
  icon: z.string().max(10).optional(),
  sort_order: z.number().int().min(0).optional(),
  is_active: z.number().int().min(0).max(1).optional(),
})

export async function categoryRoutes(app: FastifyInstance): Promise<void> {
  // 所有接口需认证
  app.addHook('preHandler', authMiddleware)

  // GET /api/categories - 获取当前用户分类列表
  app.get('/api/categories', async (request: FastifyRequest) => {
    const db = getDb()
    const userId = request.user!.userId

    const query = request.query as { type?: string; include_inactive?: string }
    let sql = 'SELECT * FROM categories WHERE user_id = ?'
    const params: unknown[] = [userId]

    if (query.type) {
      sql += ' AND type = ?'
      params.push(query.type)
    }

    if (query.include_inactive !== '1') {
      sql += ' AND is_active = 1'
    }

    sql += ' ORDER BY sort_order ASC, id ASC'

    const categories = db.prepare(sql).all(...params)
    return { code: 0, data: { items: categories }, message: '' }
  })

  // POST /api/categories - 创建分类
  app.post('/api/categories', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createCategorySchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const result = db
        .prepare(
          `INSERT INTO categories (user_id, name, type, icon, parent_id, sort_order)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          userId,
          body.name,
          body.type,
          body.icon || '📦',
          body.parent_id || null,
          body.sort_order || 0,
        )

      const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(result.lastInsertRowid)
      return { code: 0, data: category, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      if ((err as any)?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        reply.code(400)
        return { code: 3001, data: null, message: '同类型下分类名称已存在' }
      }
      throw err
    }
  })

  // PUT /api/categories/:id - 修改分类
  app.put('/api/categories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { id } = request.params as { id: string }
      const body = updateCategorySchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      // 确认归属
      const existing = db
        .prepare('SELECT id FROM categories WHERE id = ? AND user_id = ?')
        .get(Number(id), userId)
      if (!existing) {
        reply.code(404)
        return { code: 3002, data: null, message: '分类不存在' }
      }

      const updates: string[] = []
      const params: unknown[] = []

      if (body.name !== undefined) {
        updates.push('name = ?')
        params.push(body.name)
      }
      if (body.icon !== undefined) {
        updates.push('icon = ?')
        params.push(body.icon)
      }
      if (body.sort_order !== undefined) {
        updates.push('sort_order = ?')
        params.push(body.sort_order)
      }
      if (body.is_active !== undefined) {
        updates.push('is_active = ?')
        params.push(body.is_active)
      }

      if (updates.length === 0) {
        reply.code(400)
        return { code: 2000, data: null, message: '没有需要更新的字段' }
      }

      params.push(Number(id), userId)
      db.prepare(`UPDATE categories SET ${updates.join(', ')} WHERE id = ? AND user_id = ?`).run(
        ...params,
      )

      const category = db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(id))
      return { code: 0, data: category, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })

  // DELETE /api/categories/:id - 停用分类
  app.delete('/api/categories/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()
    const userId = request.user!.userId

    const result = db
      .prepare('UPDATE categories SET is_active = 0 WHERE id = ? AND user_id = ?')
      .run(Number(id), userId)

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '分类不存在' }
    }

    return { code: 0, data: null, message: '分类已停用' }
  })
}
