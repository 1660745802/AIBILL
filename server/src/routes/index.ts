import type { FastifyInstance } from 'fastify'
import { authRoutes } from './auth.js'
import { categoryRoutes } from './category.js'
import { accountRoutes } from './account.js'
import { transactionRoutes } from './transaction.js'
import { aiRoutes } from './ai.js'
import { adminRoutes, userSettingsRoutes } from './admin.js'
import { statsRoutes } from './stats.js'

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health', async () => {
    return { status: 'ok' }
  })

  // 无需认证的路由
  await authRoutes(app)

  // 需要认证的路由 — 用 register 隔离 hook 作用域
  await app.register(categoryRoutes)
  await app.register(accountRoutes)
  await app.register(transactionRoutes)
  await app.register(aiRoutes)
  await app.register(adminRoutes)
  await app.register(userSettingsRoutes)
  await app.register(statsRoutes)
}
