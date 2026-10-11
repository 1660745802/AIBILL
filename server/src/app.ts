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

  // 全局错误出口。
  //
  // 以前这里挂的是 onSend「自动包装」钩子，但全仓库 168 处响应都是路由手工返回
  // `{code,data,message}` 信封，唯一返回裸对象的 /health 又正好在钩子的跳过名单里
  // ——也就是说自动包装一次都没生效过，只是凭空多了一套可能误判的规则
  // （isWrapped 靠「payload 里有没有数字型code」猜形状，将来哪个接口的业务数据
  //  恰好带 code 字段就会被误判为已包装而原样放行）。
  // 已删除。现在约定很干脆：响应信封一律由路由手工写，框架级错误走这里。
  //
  // 位置很关键：**必须在 registerRoutes() 之前**。放在之后的话，body 解析失败
  // 这类发生在路由匹配之前的错误不会被它接管，仍然漏出 Fastify 默认体。
  app.setErrorHandler((err: unknown, request, reply) => {
    // Fastify 自家错误带 statusCode；其余一律按未捕获异常处理
    const status =
      typeof (err as { statusCode?: unknown })?.statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500
    // 5xx 一律对外只说「服务器内部错误」：真实原因（堆栈、SQL）只进日志，不外泄。
    // 4xx 是请求方自己的问题（body 解析失败、超限、限流……），原样给出可读原因。
    const rawMessage = err instanceof Error ? err.message : String(err ?? '')
    const message = status >= 500 ? '服务器内部错误' : rawMessage

    request.log.error({ err, status, url: request.url }, 'request failed')

    reply.code(status).send({ code: status, data: null, message })
  })

  await registerRoutes(app)

  // 生产模式：服务前端静态文件
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const publicDir = path.join(__dirname, '..', 'public')
  const fastifyStatic = await import('@fastify/static')

  // APK 下载：动态读磁盘（不使用 @fastify/static，
  // 避免其启动时缓存目录列表导致新上传的 APK 必须重启才能下载）
  app.get('/updates/:filename', async (request, reply) => {
    const filename = (request.params as { filename: string }).filename
    // 防 path traversal
    if (!filename || filename.includes('/') || filename.includes('..') || filename.includes('\\')) {
      reply.code(400).send({ code: 4000, data: null, message: 'invalid filename' })
      return
    }
    const filepath = path.join(config.updatesDir, filename)
    // 限定在 updatesDir 下，防 symlink 跳出
    const resolved = path.resolve(filepath)
    const resolvedRoot = path.resolve(config.updatesDir)
    if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
      reply.code(400).send({ code: 4000, data: null, message: 'invalid path' })
      return
    }
    if (!fs.existsSync(filepath)) {
      reply.code(404).send({ code: 4004, data: null, message: 'file not found' })
      return
    }
    reply.type('application/vnd.android.package-archive')
    reply.header('Content-Length', fs.statSync(filepath).size.toString())
    // 支持范围请求（resume download）
    return reply.send(fs.createReadStream(filepath))
  })

  const hasPublicDir = fs.existsSync(publicDir)

  if (hasPublicDir) {
    await app.register(fastifyStatic.default, {
      root: publicDir,
      prefix: '/',
      decorateReply: false, // 避免与上面的注册冲突
      wildcard: false,
    })
  }

  // 404 处理**无条件注册**（之前它嵌在 if (fs.existsSync(publicDir)) 里，
  // 于是本地开发 / 没构建前端时，/api/xxx 打错字会漏出 Fastify 默认体
  // {statusCode,error,message}，和其余接口的信封形状对不上——前端解包就炸）。
  const indexHtml = path.join(publicDir, 'index.html')
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      reply.code(404).send({ code: 4004, data: null, message: '接口不存在' })
      return
    }
    // SPA fallback：非 API 路由返回 index.html。
    // 注意：静态用 decorateReply:false 注册，reply.sendFile 不可用，
    // 必须自己读文件流发送（否则 /quick 等深链会 500）。
    if (hasPublicDir && fs.existsSync(indexHtml)) {
      if (request.url === '/favicon.ico') {
        return reply.redirect('/icons/icon-512.svg', 302)
      }
      reply.type('text/html; charset=utf-8')
      return reply.send(fs.createReadStream(indexHtml))
    }
    reply.code(404).send({ code: 4004, data: null, message: 'Not Found' })
  })

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
