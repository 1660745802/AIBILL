import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config } from './config.js'
import { registerRoutes } from './routes/index.js'
import { initDb, closeDb } from './db/index.js'
import { ensureAdminUser } from './services/auth.service.js'
import { startScheduler, stopScheduler } from './services/scheduler.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'

const app = Fastify({ logger: true })

async function start(): Promise<void> {
  // 初始化数据库（建表 + migration）
  initDb()
  console.log('[App] Database initialized')

  // 确保 APK 存储目录存在
  if (!fs.existsSync(config.updatesDir)) {
    fs.mkdirSync(config.updatesDir, { recursive: true })
  }

  // 安全警告
  if (config.jwtSecret === 'your-random-secret-at-least-32-chars') {
    console.warn('[⚠️  Security] JWT_SECRET 使用默认值，生产环境请务必设置自定义密钥！')
  }
  if (config.adminPassword === 'changeme123') {
    console.warn('[⚠️  Security] ADMIN_PASSWORD 使用默认值，请尽快修改！')
  }

  // 确保管理员账户存在
  ensureAdminUser()

  // 确保默认通知规则存在
  const { ensureDefaultNotificationRules } = await import('./db/seed-notification-rules.js')
  ensureDefaultNotificationRules()

  await app.register(cors, {
    origin: (origin, cb) => {
      // 同源请求（curl/Postman）允许无 Origin header
      if (!origin) {
        cb(null, true)
        return
      }
      // 配置了 '*' 或 origin 在白名单内 → 允许
      if (config.corsOrigins.includes('*') || config.corsOrigins.includes(origin)) {
        cb(null, true)
        return
      }
      cb(new Error('CORS not allowed'), false)
    },
    // 不需要 credentials：项目用 JWT Bearer header（localStorage），
    // 不依赖 cookie。开启 credentials 会与 origin: '*' 冲突。
    credentials: false,
  })

  // Multipart 支持（用于文件上传）
  const multipart = (await import('@fastify/multipart')).default
  await app.register(multipart, {
    limits: {
      fileSize: 200 * 1024 * 1024, // 200MB 上限（APK 文件可能较大）
    },
  })

  // 全局限流（按 IP）
  const rateLimit = (await import('@fastify/rate-limit')).default
  await app.register(rateLimit, {
    global: false, // 默认不限制，按路由单独开启
  })

  // 请求日志钩子：记录关键 API 调用到 app_logs
  const { appLog } = await import('./services/logger.js')

  app.addHook('onResponse', (request, reply, done) => {
    const url = request.url
    const method = request.method

    // 只记录写操作和关键读操作，跳过静态资源和高频轮询
    const shouldLog =
      (method === 'POST' || method === 'PUT' || method === 'DELETE') &&
      url.startsWith('/api/')

    if (shouldLog) {
      const userId = request.user?.userId || 0
      const status = reply.statusCode
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info'
      const module = url.split('/')[2] || 'api' // /api/[module]/...

      appLog(level, module, `${method} ${url} → ${status}`, {
        user_id: userId,
        status,
        duration_ms: Math.round(reply.elapsedTime),
      })
    }
    done()
  })

  await registerRoutes(app)

  // 全局响应包装：未包装的响应自动加 {code:0, data, message}
  // 已含 `code` 字段的（手工 success/fail）保持原样
  // 跳过：/health（外部探针）、文件下载（Content-Disposition: attachment）、静态文件
  // 注意：Fastify onSend 要求返回 string/Buffer/object；返回 object 时需确保 Content-Type 是 JSON
  const { isWrapped } = await import('./lib/response.js')
  app.addHook('onSend', async (request, reply, payload) => {
    const status = reply.statusCode
    const contentType = String(reply.getHeader('content-type') || '')
    const contentDisposition = reply.getHeader('content-disposition') || ''
    const url = request.url || ''

    // 跳过条件：
    // 1. 健康检查（k8s/外部探针）
    // 2. 文件下载（导出 JSON/CSV）
    // 3. 静态资源（text/html、css、js 等）
    // 4. 非 API 路由（前端 SPA 静态文件）
    if (
      url === '/health' ||
      String(contentDisposition).includes('attachment') ||
      contentType.includes('text/') ||
      contentType.includes('octet-stream') ||
      (!url.startsWith('/api/') && status < 400)
    ) {
      return payload
    }

    // payload 可能是 string（已 JSON 序列化）或 object（Fastify 待序列化）
    let parsed: unknown = payload
    if (typeof payload === 'string') {
      try {
        parsed = JSON.parse(payload)
      } catch {
        return payload // 非 JSON 字符串，原样返回
      }
    }

    // 已包装 → 原样返回
    if (isWrapped(parsed)) {
      return payload
    }

    // 未包装 → 自动包装
    if (parsed === null || parsed === undefined) {
      return JSON.stringify({ code: 0, data: null, message: '' })
    }
    return JSON.stringify({
      code: status >= 400 ? status : 0,
      data: parsed,
      message: '',
    })
  })

  // 生产模式：服务前端静态文件
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const publicDir = path.join(__dirname, '..', 'public')
  const fastifyStatic = await import('@fastify/static')

  // APK 下载：服务 data/updates/ 目录（始终注册，不依赖 publicDir）
  if (fs.existsSync(config.updatesDir)) {
    await app.register(fastifyStatic.default, {
      root: config.updatesDir,
      prefix: '/updates/',
      wildcard: false,
    })
  }

  if (fs.existsSync(publicDir)) {
    await app.register(fastifyStatic.default, {
      root: publicDir,
      prefix: '/',
      decorateReply: false, // 避免与上面的注册冲突
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
    stopScheduler()
    await app.close()
    closeDb()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    await app.listen({ port: config.port, host: '0.0.0.0' })
    console.log(`[App] Server listening on port ${config.port}`)
    startScheduler()
  } catch (err) {
    app.log.error(err)
    closeDb()
    process.exit(1)
  }
}

start()
