import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { registerRoutes } from './routes/index.js'
import { initDb, closeDb } from './db/index.js'
import { ensureAdminUser } from './services/auth.service.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

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

  // 生产模式：服务前端静态文件
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const publicDir = path.join(__dirname, '..', 'public')
  if (fs.existsSync(publicDir)) {
    const fastifyStatic = await import('@fastify/static')
    await app.register(fastifyStatic.default, {
      root: publicDir,
      prefix: '/',
      wildcard: false,
    })
    // SPA fallback: 非 API 路由返回 index.html
    app.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ code: 4004, data: null, message: '接口不存在' })
      } else {
        return reply.sendFile('index.html')
      }
    })
  }

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
