/**
 * 邀请码（3 端点）。创建邀请码 / 列表 / 作废；邀请码是**全局资源**，
 * 创建者被删时 `created_by` 置空而不是删码（见 `lib/admin-purge.ts`）。
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { z } from 'zod'
import { getDb } from '../../db/index.js'
import crypto from 'node:crypto'

const createInviteCodeSchema = z.object({
  max_uses: z.number().int().min(1).max(1000).optional().default(1),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
})

export async function adminInviteRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/admin/invite-codes', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = createInviteCodeSchema.parse(request.body)
      const db = getDb()
      const userId = request.user!.userId

      const code = crypto.randomBytes(4).toString('hex').toUpperCase()

      db.prepare(
        'INSERT INTO invite_codes (code, max_uses, created_by, expires_at) VALUES (?, ?, ?, ?)',
      ).run(code, body.max_uses, userId, body.expires_at || null)

      const inviteCode = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(code)
      return { code: 0, data: inviteCode, message: '' }
    } catch (err) {
      if (err instanceof z.ZodError) {
        reply.code(400)
        return { code: 2000, data: null, message: err.errors[0].message }
      }
      throw err
    }
  })


  // GET /api/admin/invite-codes - 邀请码列表
  app.get('/api/admin/invite-codes', async () => {
    const db = getDb()
    const codes = db
      .prepare('SELECT * FROM invite_codes ORDER BY created_at DESC')
      .all()
    return { code: 0, data: { items: codes }, message: '' }
  })


  // DELETE /api/admin/invite-codes/:id - 作废邀请码
  app.delete('/api/admin/invite-codes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const { id } = request.params as { id: string }
    const db = getDb()

    // 将 max_uses 设为 used_count，使其立即失效
    const result = db
      .prepare('UPDATE invite_codes SET max_uses = used_count WHERE id = ?')
      .run(Number(id))

    if (result.changes === 0) {
      reply.code(404)
      return { code: 3002, data: null, message: '邀请码不存在' }
    }

    return { code: 0, data: null, message: '邀请码已作废' }
  })
}
