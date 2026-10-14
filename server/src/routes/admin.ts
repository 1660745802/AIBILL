/**
 * 管理员路由 - /api/admin
 *
 * **挂载壳**：只负责加鉴权 hook + 把资源 module 注册进来，本身不含业务 SQL。
 * 23 个端点按资源族拆进 `routes/admin/*.ts`：
 * invites(3) · users(6) · settings(2，另有 `userSettingsRoutes` 的 2 个) · filter-stats(1) ·
 * unparsed(2) · samples(3) · ai-quality(3) · logs(1)。
 *
 * hook 必须**先于**注册：Fastify 在注册路由那一刻把当前作用域的 hook 绑给它，
 * 所以这里先 addHook、再逐个调用子 module（子 module 都在同一作用域注册）。
 */
import type { FastifyInstance } from 'fastify'
import { authMiddleware, adminMiddleware } from '../middleware/auth.js'
import { adminInviteRoutes } from './admin/invites.js'
import { adminUserRoutes } from './admin/users.js'
import { adminSettingsRoutes, userSettingsRoutes } from './admin/settings.js'
import { adminFilterStatsRoutes } from './admin/filter-stats.js'
import { adminUnparsedRoutes } from './admin/unparsed.js'
import { adminSampleRoutes } from './admin/samples.js'
import { adminAiQualityRoutes } from './admin/ai-quality.js'
import { adminLogRoutes } from './admin/logs.js'

/** `/api/settings` 只需 auth，由 index.ts 单独注册（不在 admin 鉴权作用域内） */
export { userSettingsRoutes }

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authMiddleware)
  app.addHook('preHandler', adminMiddleware)

  await adminInviteRoutes(app)
  await adminUserRoutes(app)
  await adminSettingsRoutes(app)
  await adminFilterStatsRoutes(app)
  await adminUnparsedRoutes(app)
  await adminSampleRoutes(app)
  await adminAiQualityRoutes(app)
  await adminLogRoutes(app)
}
