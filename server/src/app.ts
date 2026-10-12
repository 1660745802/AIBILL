import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, PLACEHOLDER_JWT_SECRETS, PLACEHOLDER_ADMIN_PASSWORDS } from './config.js'
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

  // 安全警告（占位值清单位于 config.ts，compose 的兜底值也在列）
  if (PLACEHOLDER_JWT_SECRETS.includes(config.jwtSecret)) {
    console.warn('[⚠️  Security] JWT_SECRET 使用默认/占位值，生产环境请务必设置自定义密钥！')
  }
  if (PLACEHOLDER_ADMIN_PASSWORDS.includes(config.adminPassword)) {
    console.warn('[⚠️  Security] ADMIN_PASSWORD 使用默认值，请尽快修改！')
  }
  if (config.corsOrigins.includes('*')) {
    console.warn('[⚠️  Security] CORS_ORIGINS=*，生产环境应改为具体 origin 白名单')
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
      // 403，不是框架默认的 500：这是策略拒绝（origin 不在白名单），不是服务端故障。
      // 用 500 会有两个副作用：客户端把「配错了 CORS」当服务异常（API.md §0.2 中
      // 403 才是权限不足）；且 onResponse 钩子把它记成 error 级 app_logs，
      // 任意跨域请求（无认证）都能往生产库刷错误日志。
      const denied = new Error('CORS not allowed') as Error & { statusCode: number }
      denied.statusCode = 403
      cb(denied, false)
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
    // 4xx 是请求方自己的问题（body 解析失败、超限、CORS 拒绝……），原样给出可读原因。
    const rawMessage = err instanceof Error ? err.message : String(err ?? '')
    const message = status >= 500 ? '服务器内部错误' : rawMessage

    // 日志级别同理：4xx 记 warn。error 级代表「服务端坏了」，
    // 否则未认证的坏请求（漏 Origin 的跨域、坏 JSON）能一直往日志里灌 error。
    if (status >= 500) {
      request.log.error({ err, status, url: request.url }, 'request failed')
    } else {
      request.log.warn({ status, url: request.url, message }, 'request rejected')
    }

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
    // 注意：这里只是整文件流式发送，Node/Fastify **不处理 Range 头**——
    // 即「断点续传」并未实现（实测 Range: bytes=2-4 返回 200 而非 206，
    // 无 Content-Range/Accept-Ranges）。Android 客户端要 resume 得自己实现
    // 206/Content-Range，或把这段换成 @fastify/static 的 sendFile（它支持 Range）。
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

  // 优雅关闭（幂等：SIGINT/SIGTERM 可能前后到达，app.close()/closeDb() 不可重入）
  let shuttingDown = false
  const shutdown = async () => {
    if (shuttingDown) return
    shuttingDown = true
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

start().catch((err) => {
  // 启动期异常（initDb / migration / ensureAdminUser / 插件注册）以前没人接：
  // 会以 unhandled rejection 结束进程，既不关 DB 也不打结构化日志。
  // app.listen 自身的失败已在 start() 内处理，这里兜住其余部分。
  console.error('[App] 启动失败', err)
  try {
    closeDb()
  } catch {
    // 可能还没初始化
  }
  process.exit(1)
})
