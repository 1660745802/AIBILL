import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { registerRoutes } from './routes/index.js'
import { initDb, closeDb } from './db/index.js'
import { ensureAdminUser } from './services/auth.service.js'

const app = Fastify({ logger: true })

async function start(): Promise<void> {
  // 初始化数据库（建表 + migration）
  initDb()
  console.log('[App] Database initialized')

  // 安全警告
  if (config.jwtSecret === 'your-random-secret-at-least-32-chars') {
    console.warn('[⚠️  Security] JWT_SECRET 使用默认值，生产环境请务必设置自定义密钥！')
  }
  if (config.adminPassword === 'changeme123') {
    console.warn('[⚠️  Security] ADMIN_PASSWORD 使用默认值，请尽快修改！')
  }

  // 确保管理员账户存在
  ensureAdminUser()

  await app.register(cors)
  await registerRoutes(app)

  // 优雅关闭
  const shutdown = async () => {
    await app.close()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`[App] Server listening on port ${config.port}`)
  } catch (err) {
    app.log.error(err)
    closeDb()
    process.exit(1)
  }
}

start()
