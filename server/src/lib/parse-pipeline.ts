/**
 * 解析编排（ParsePipeline）
 *
 * `POST /api/ai/parse` 的**全部业务编排**：锚定日期 → hints 冲突 → extras →
 * 分类/账户查询 → quick 路径 → 入站预筛 → 模型调用（有限重试）→ 机械校验 →
 * 装配 → 出站校验 → 落日志 → 落地关联。
 *
 * **为什么要有这层**：路由此前是「鉴权 + 限流 + 入参 + 编排 + 出参 + 错误分支」
 * 一锅煮，读一个业务入口要穿过全部 HTTP 关注点，「哪段是业务」靠读注释才分得清。
 * 收进来后本模块的 interface 只有两件事：
 *
 *   `runParse(db, { userId, body, rawBody }) → ParseOutcome`（判别联合）
 *
 * 路由不必知道解析里有重试预算、预筛、装配、回填——它只看 outcome 拼 HTTP 响应
 * （形状见 routes/ai.ts，被 tests/compat/client-response-shape.test.ts 钉住）。
 *
 * **边界**：本模块**碰 DB、不碰 HTTP**——不 import fastify、不 `reply.code`、
 * 不 `return` 响应体；失败以 outcome 返回，而不是抛给调用方。反过来，入参校验
 * （zod 与 `ZodError`）属于路由，**不在本模块**（它连 `body` 都假定已校验过）。
 *
 * `rawBody` 是**未截断的原始请求体**：仅错误路径用它复刻旧 handler 的
 * `request.body` 口径（a11y 超长时日志/响应里的 `raw_input` 是截断前的原文，
 * `hints` 也是原始 JSON）。主流程一律用已校验、已截断的 `body`。
 */
import { chatCompletion, AiError } from '../ai/client.js'
import { today, toDateStr, addDaysTo } from './date.js'
import { buildParsePrompt } from '../ai/prompts.js'
import { extractJsonArray, validateParsedItems, ParseError, type ParsedTransaction } from '../ai/parser.js'
import { quickParse } from '../ai/quick-parser.js'
import { extractParsedExtras } from './parse-extract.js'
import { resolveItems, finalizeItems, type CategoryRow, type AccountRow } from './parse-assembly.js'
import { pickMainItem } from './main-item.js'
import { getSourceMapping } from './notification-rules.js'
import {
  classifyNotification,
  shouldCallAi,
  requiresCorroboration,
  verifyParsed,
  extractMoneyAmounts,
} from '../ai/verify.js'
import { rememberParse } from './parse-landing.js'
import { recordFiltered } from './parse-filter.js'
import { appLog } from '../services/logger.js'
import {
  failureCodeOf,
  isRetryableFailure,
  retryAfterMsOf,
  retryDelayMs,
  PARSE_MAX_ATTEMPTS,
  PARSE_ATTEMPT_TIMEOUT_MS,
  PARSE_INPUT_MAX_LEN,
  PARSE_INPUT_A11Y_MAX_LEN,
  type AiFailureCode,
} from './ai-failure.js'
import type { getDb } from '../db/index.js'

type Db = ReturnType<typeof getDb>

/** 装配后的一条响应 item（`finalizeItems` 的产出，形状即响应 `data.items[]`）。 */
export type ParseItem = ReturnType<typeof finalizeItems>[number]

/**
 * 已通过 zod 校验的 `POST /api/ai/parse` 入参。
 *
 * 与 `routes/ai.ts` 的 `parseInputSchema` 一一对应；这里只声明**本模块真正读**的
 * 字段（结构类型，路由的 `z.infer` 结果可直接传入）。
 */
export interface ParseInput {
  input: string
  channel?: 'nls' | 'sms' | 'a11y' | 'manual'
  source?: { package_name: string; source_name?: string }
  title?: string
  body?: string
  received_at?: string
  hints?: {
    amount_cents?: number
    merchant?: string
    account_name?: string
    direction?: 'expense' | 'income' | 'transfer'
  }
}

/** `runParse` 的入参。 */
export interface RunParseArgs {
  userId: number
  /** zod 校验后的入参（a11y 超长已截断）。 */
  body: ParseInput
  /**
   * 原始请求体（未截断）。**仅错误路径**复刻旧 handler 的 `request.body` 口径：
   * a11y 超长时 `raw_input` 记原文、`hints` 存原始 JSON。主流程不用它。
   */
  rawBody: unknown
}

/* ══════════════════════════════════════════════════════════════════════════
 * ParseOutcome：handler 此前返回的每一种结果，收敛成一个判别联合。
 * 路由按 `kind` 拼出**逐字节不变**的响应体（见 routes/ai.ts 的 switch）。
 * ══════════════════════════════════════════════════════════════════════════ */

/** quick / ai 成功：响应 `data = { items, extra_items_dropped, raw_input, parse_log_id, source, hints_conflict }`。 */
export interface ParseParsedOutcome {
  kind: 'parsed'
  /** 响应 `data.source`：quick=本地正则，ai=模型。 */
  source: 'quick' | 'ai'
  /** 已裁成「一笔」的 items（`pickMainItem` 产出）。 */
  items: ParseItem[]
  droppedCount: number
  rawInput: string
  logId: number
  hintsConflict: boolean
}

/** 入站/出站预筛挡下：响应 `data.source` = prefilter / postfilter。 */
export interface ParseFilteredOutcome {
  kind: 'filtered'
  source: 'prefilter' | 'postfilter'
  rawInput: string
  outcome: 'not_a_bill'
  message: string
}

/** 模型判非账（回 `[]`）：`code 5001` + `outcome not_a_bill` + `parse_log_id`。 */
export interface ParseEmptyOutcome {
  kind: 'empty'
  rawInput: string
  logId: number
  httpStatus: 200
  outcome: 'not_a_bill'
  message: string
}

/** 入参超渠道上限（已留痕）：`code 2000` + 400。 */
export interface ParseInputTooLongOutcome {
  kind: 'input_too_long'
  httpStatus: 400
  outcome: 'unavailable'
  message: string
}

/** AI 不可用（超时/上游错误）：`code 5001` + 504(AI_TIMEOUT) / 502(其余)。 */
export interface ParseAiErrorOutcome {
  kind: 'ai_error'
  message: string
  httpStatus: 502 | 504
  outcome: 'unavailable'
  rawInput: string
}

/** 模型输出不可解析/不可用：`code 5002` + 200。 */
export interface ParseParseErrorOutcome {
  kind: 'parse_error'
  httpStatus: 200
  outcome: 'unavailable'
  message: string
  rawInput: string
}

export type ParseOutcome =
  | ParseParsedOutcome
  | ParseFilteredOutcome
  | ParseEmptyOutcome
  | ParseInputTooLongOutcome
  | ParseAiErrorOutcome
  | ParseParseErrorOutcome

/**
 * 从**未校验**的原始 body 里宽松读出入参上下文（错误路径用）。
 *
 * 模型超时 / 响应格式异常时，zod 解析出的 `body` 可能不在作用域里，但日志仍然
 * 应该记下这条请求的入口归因。宽容读取：任何字段形状不对就当没有，**不让日志
 * 提取反过来把错误处理搞挂**。
 */
export function readParseMeta(raw: unknown): {
  channel: string | null
  sourcePackage: string | null
  receivedAt: string | null
  hints: string | null
} {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const src = (b.source && typeof b.source === 'object' ? b.source : {}) as Record<string, unknown>
  return {
    channel: typeof b.channel === 'string' ? b.channel : null,
    sourcePackage: typeof src.package_name === 'string' ? src.package_name : null,
    receivedAt: typeof b.received_at === 'string' ? b.received_at : null,
    hints: b.hints && typeof b.hints === 'object' ? JSON.stringify(b.hints) : null,
  }
}

/**
 * 插入 AI 解析日志
 *
 * `channel` / `sourcePackage` / `receivedAt` / `hints` 是 019 新增的**可空**留档列：
 * 旧调用点不传就是 NULL（不猜值），新调用点把入参上下文原样落下来。
 *
 * `failureCode` / `attempts` 是 022 新增的**可空**列（失败可观测，见 lib/ai-failure.ts）：
 * `failureCode` NULL = 本次没有失败（成功，或 AI 判非账）；`attempts` = 实际调了几次模型。
 *
 * 导出供路由层的入参校验失败（`ZodError`）分支复用（那条通路不经过 `runParse`）。
 */
export function insertParseLog(
  db: Db,
  params: {
    userId: number
    rawInput: string
    cleanedInput: string | null
    aiResponse: string | null
    parsedItems: string | null
    status: 'success' | 'empty' | 'error' | 'timeout'
    errorMessage: string | null
    durationMs: number
    channel?: string | null
    sourcePackage?: string | null
    receivedAt?: string | null
    hints?: string | null
    failureCode?: AiFailureCode | null
    attempts?: number | null
  },
): number {
  const result = db.prepare(
    `INSERT INTO ai_parse_logs
       (user_id, raw_input, cleaned_input, ai_response, parsed_items, status, error_message, duration_ms,
        channel, source_package, received_at, hints, failure_code, attempts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.userId,
    params.rawInput,
    params.cleanedInput,
    params.aiResponse,
    params.parsedItems,
    params.status,
    params.errorMessage,
    params.durationMs,
    params.channel ?? null,
    params.sourcePackage ?? null,
    params.receivedAt ?? null,
    params.hints ?? null,
    params.failureCode ?? null,
    params.attempts ?? null,
  )
  return Number(result.lastInsertRowid)
}

/**
 * 推出本次请求的「锚定日期」（北京口径的 YYYY-MM-DD）。
 *
 * 为什么需要它：通知 23:40 到达、客户端 00:05 才联网解析时，如果直接用今天的
 * `today()`，这笔账会被写到「明天」——用户看到日期不对。所以客户端送
 * `received_at`，服务端取它的**北京日期**作为这次请求的「今天」，并在
 * quickParse / buildPrompt / validateParsedItems 里**用同一个值**（同一请求内一致）。
 *
 * 护栏：手机时钟歪（或客户端乱填）时，锚定日期会离谱。只接受落在
 * [北京今天-7 天, 北京今天+1 天] 内的值——**+1 天保留**是因为「通知 23:40 到、
 * 用户次日凌晨才联」本来就可能晚一天入库，而「-7 天」给换机/补录留余地。
 * 越界就回落 `today()` 并打 warn，不让一个坏时间戳把整批账写到几年前。
 *
 * 导出是为了能在测试里直接锁这个窗口判据（路由层不易构造「未来日期」）。
 */
export function resolveAnchorDate(receivedAt: string | undefined, userId: number): string {
  const fallback = today()
  if (!receivedAt) return fallback

  const ts = Date.parse(receivedAt)
  if (Number.isNaN(ts)) return fallback // 理论上 zod 已拦；防御性兼底

  const anchor = toDateStr(new Date(ts))
  const low = addDaysTo(fallback, -7)
  const high = addDaysTo(fallback, 1)
  if (anchor < low || anchor > high) {
    appLog('warn', 'ai', 'received_at 超出可信窗口，按今天处理', {
      user_id: userId,
      received_at: receivedAt,
      anchor_date: anchor,
      window: [low, high],
    })
    return fallback
  }
  return anchor
}

/**
 * 机械算出「hints 金额与文本金额是否矛盾」。
 *
 * 只在三个条件都成立时才可能为 true：有 `amount_cents`、文本里能抽出带单位的金额、
 * 且 hint 金额不在该集合里。任缺其一返回 false（「没有信号」不等于「矛盾」，
 * 不能把缺依据当成冲突——否则客户端会对着一张没有金额的通知弹警告）。
 *
 * 比对是分→元的可逆换算，与 `extractMoneyAmounts` 的「元保留两位」同口径。
 */
export function computeHintsConflict(amountCents: number | undefined, rawInput: string): boolean {
  if (amountCents == null) return false
  const amounts = extractMoneyAmounts(rawInput)
  if (amounts.size === 0) return false
  const hintYuan = Math.round(amountCents / 100 * 100) / 100
  return !amounts.has(hintYuan)
}

/** 重试退避用 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 预清理输入文本，去除通知标题噪音
 */
function cleanInput(input: string): string {
  let text = input.trim()

  // 去除通知标题前缀（如 "[3条]动账通知"、"[招商银行]"）
  text = text.replace(/^\[?\d+条\]?\s*/g, '')
  text = text.replace(/^[\[【].*?[\]】]\s*/g, '')

  // 去除重复的标题（如 "动账通知 动账通知"）
  text = text.replace(/^(.{2,10})\s+\1\s*/g, '$1 ')

  // 去除开头的通知类关键词
  text = text.replace(/^(动账通知|交易提醒|消费提醒|收支通知)\s*/g, '')

  // 去除多余空白
  text = text.replace(/\s+/g, ' ').trim()

  return text || input.trim()
}

/**
 * `POST /api/ai/parse` 的编排入口。
 *
 * 覆盖 handler 此前返回的全部结果（成功 / 入站预筛 / 出站预筛 / 空结果 /
 * 输入过长 / AI 不可用 / 输出不可用），每一条都带回路由拼响应所需的数据。
 * 重试预算、日志字段、`rememberParse` 调用时机与两条路径的所有细节均与
 * 拆分前的 handler 逐行一致。
 */
export async function runParse(db: Db, args: RunParseArgs): Promise<ParseOutcome> {
  const { userId, body, rawBody } = args
  const startTime = Date.now()
  /* 本次请求实际调了几次模型（服务端同步重试，见 lib/ai-failure.ts）。
     1 = 没重试；落 `ai_parse_logs.attempts`，让「重试救回了多少」可量化。 */
  let attempts = 0

  try {
    /* 渠道上限：非 a11y 超限也**必须留痕**（此前 400 且零日志 → 两端都查不到）。
       a11y 的超长已在路由层截断，不会进这里。 */
    const maxLen = body.channel === 'a11y' ? PARSE_INPUT_A11Y_MAX_LEN : PARSE_INPUT_MAX_LEN
    if (body.input.length > maxLen) {
      insertParseLog(db, {
        userId,
        rawInput: body.input.slice(0, 200),
        cleanedInput: null,
        aiResponse: null,
        parsedItems: null,
        status: 'error',
        errorMessage: `input_too_long: ${body.input.length} > ${maxLen}`,
        durationMs: Date.now() - startTime,
        failureCode: 'input_too_long',
        attempts: 0,
        ...readParseMeta(rawBody),
      })
      return { kind: 'input_too_long', httpStatus: 400, outcome: 'unavailable', message: '输入过长' }
    }

    /* 本请求的「今天」= 通知到达日的**北京日期**（有 received_at 时），否则 today()。
       通知 23:40 到、00:05 才解析，必须落在通知当天，否则 date 会被记成隔天。 */
    const anchorDate = resolveAnchorDate(body.received_at, userId)

    /* hints 只用来算 hints_conflict，**绝不拼进 prompt**：
       hints 一旦进 prompt，模型会直接抄 hint 而不读文本，绕过金额佐证
       （verify.ts 的 hasCorroboration）→ 客户端拿到一个「文本里根本没有的数字」，
       也就是伪造账目。金额冲突标记是机械比对，不依赖模型，所以可以给。 */
    const hintsConflict = computeHintsConflict(body.hints?.amount_cents, body.input)

    // 入参上下文落库（仅留档，见 migration 019）
    const logMeta = {
      channel: body.channel ?? null,
      sourcePackage: body.source?.package_name ?? null,
      receivedAt: body.received_at ?? null,
      hints: body.hints ? JSON.stringify(body.hints) : null,
    }

    /* ═══ 出参扩展（契约 §6）：机械抽取，不进 prompt ═══
       `input` 为主，抽不到再退回 title/body（S2 已收）。
       ⚠️ 只有**抽取**能退回 title/body；tier/佐证判据（deriveReviewMeta 的
       `input`）**只许用 input**——title/body 暂不参与判据。 */
    const friendlySource = body.source
      ? getSourceMapping(db)[body.source.package_name]
      : undefined
    const fallbackText = [body.title, body.body]
      .filter((s): s is string => !!s)
      .join(' ')
    const extras = extractParsedExtras(body.input, { fallbackText, sourceName: friendlySource })

    // 获取用户的分类和账户列表
    const categories = db
      .prepare('SELECT id, name, type, icon FROM categories WHERE user_id = ? AND is_active = 1')
      .all(userId) as CategoryRow[]

    const accounts = db
      .prepare('SELECT id, name FROM accounts WHERE user_id = ? AND is_active = 1')
      .all(userId) as AccountRow[]

    const expenseCategories = categories.filter((c) => c.type === 'expense')
    const incomeCategories = categories.filter((c) => c.type === 'income')

    // 预清理输入文本（去除通知标题噪音）
    const cleanedInput = cleanInput(body.input)

    // === 快捷解析：简单输入直接正则匹配，毫秒级响应 ===
    const quickResult = quickParse(cleanedInput, {
      today: anchorDate,
      expenseCategories: expenseCategories.map((c) => c.name),
      incomeCategories: incomeCategories.map((c) => c.name),
      accounts: accounts.map((a) => a.name),
    })

    if (quickResult) {
      // 归类 + 账户匹配 + §6 机械字段：唯一实现在 lib/parse-assembly.ts
      const assemblyCtx = { input: body.input, categories, accounts, extras, path: 'quick' as const }
      const items = finalizeItems(resolveItems(quickResult, assemblyCtx), assemblyCtx)

      // 记录日志（快捷解析也记录，方便对比质量）
      const durationMs = Date.now() - startTime
      const logId = insertParseLog(db, {
        userId,
        rawInput: body.input,
        cleanedInput,
        aiResponse: '[quick-parse]',
        parsedItems: JSON.stringify(items),
        status: 'success',
        errorMessage: null,
        durationMs,
        failureCode: null,
        attempts,
        ...logMeta,
      })

      /* 一次解析只回一笔（取消批量记账，契约不变量）。全部条目已写进
         `ai_parse_logs.parsed_items`，这里只裁响应并把裁掉的条数回给客户端。 */
      const picked = pickMainItem(items, body.input)
      /* 落地关联：与 ai 路径同口径。quick 同样返回 parse_log_id，此前不 rememberParse
         → 这些行永远拿不到 ai_raw_input/final_items 回填。 */
      rememberParse(userId, logId, (picked.main ? [picked.main] : []) as any, body.input)
      return {
        kind: 'parsed',
        source: 'quick',
        items: picked.main ? [picked.main] : [],
        droppedCount: picked.droppedCount,
        rawInput: body.input,
        logId,
        hintsConflict,
      }
    }

    /* ═══ 入站分流：判断这条通知值不值得花一次模型调用 ═══
       顺序很重要：**必须在 quickParse 之后**。
       分流的规则是按通知形态写的（无货币单位 + 无交易动词 → 噪声），
       而 quickParse 处理的正是「午饭32」这种手打短句——它没有货币单位、
       也没有交易动词，先分流会把它们全丢掉。
       （tests/routes/memories.test.ts 里的两个用例就是抓这个的。）

       线上实测 1419 条通知里 759 条（53%）是纯噪声，日志的「空结果率」
       因此基本没有诊断价值——分不清「模型不行」和「这是条广告」。
       分流把这类记录在调模型前挡掉，写进独立表 ai_parse_filters
       （不往 ai_parse_logs.status 里塞 'filtered'——那个字段有 CHECK 约束，
       为它重建一张 1419 行的表不值得），于是「省了多少」是一个可数的指标。 */
    const classifyStart = Date.now()
    // **必须传 channel**：bare_amount 是唯一一条带入口约束的信号（notify 入口不吃它），
    // 不传就会退回 manual 口径，群聊/来电/订单状态又会被当成金额信号放去调模型。
    // 读不到 channel 的历史请求一律当 manual —— 宁可多调一次模型，也不能默默放掉真账。
    const classification = classifyNotification(body.input, body.channel ?? 'manual')
    /* `duration_ms` 记的是**判定本身**的耗时（DATA §10.4：`分流是纯字符串匹配，应 <1ms`），
       不是整个请求的耗时。入站就从 classify 开始量，出站（下面）只量 verifyParsed；
       拿 `Date.now() - startTime` 会把 quickParse / 两条分类查询、尤其**整段模型调用**
       算进去，于是 filterStats.medianMs/maxMs 这个「预筛比模型快两个数量级」的
       指标彻底失去意义（出站那条动辄几十秒）。 */
    const classifyMs = Date.now() - classifyStart
    if (!shouldCallAi(classification)) {
      recordFiltered(db, {
        userId,
        rawInput: body.input,
        cleanedInput,
        stage: 'inbound',
        tier: classification.tier,
        reasons: classification.reasons,
        durationMs: classifyMs,
        channel: body.channel ?? null,
        sourcePackage: body.source?.package_name ?? null,
      })
      return {
        kind: 'filtered',
        source: 'prefilter',
        rawInput: body.input,
        // 空 items ⇔ 有 outcome（不变量，见 API.md 附录 C §1）
        outcome: 'not_a_bill',
        message: '',
      }
    }

    // === AI 解析：复杂输入走 LLM ===

    // 根据输入长度选择快速/完整 prompt
    const systemPrompt = buildParsePrompt({
      today: anchorDate,
      expenseCategories: expenseCategories.map((c) => c.name),
      incomeCategories: incomeCategories.map((c) => c.name),
      accounts: accounts.map((a) => a.name),
    }, cleanedInput.length)

    // 注入用户偏好记忆（仅 source='manual'，防 AI 自我污染）
    let finalSystemPrompt = systemPrompt
    const memories = db
      .prepare(
        `SELECT content FROM ai_memories
         WHERE user_id = ? AND is_active = 1 AND source = 'manual'
         ORDER BY created_at DESC LIMIT 20`,
      )
      .all(userId) as Array<{ content: string }>

    if (memories.length > 0) {
      const memoryLines = memories.map((m) => `- ${m.content}`).join('\n')
      finalSystemPrompt += `\n\n## 用户偏好记忆\n${memoryLines}\n\n参考以上偏好进行解析，但用户明确指定的信息优先。`
    }

    // 调用 LLM（user content 用 <user_input> 包裹，防止 prompt 注入）
    const messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: finalSystemPrompt },
      { role: 'user', content: `<user_input>\n${cleanedInput}\n</user_input>` },
    ]

    /* ═══ 模型调用 + 解析 + 校验：有限重试（重试责任在服务端） ═══

       客户端不再对 5xx/超时重试（它拿不到上游可观测性），且失败后不打扰用户，
       所以「瞬时故障救回来」这件事只能由服务端做。重试预算见 lib/ai-failure.ts：
       单次 30s × 2 次 + 退避 ≈ 61s < 客户端 90s HTTP 超时。

       重试覆盖**三步**，不只是网络：call(上游) → extractJsonArray(格式) →
       validateParsedItems(机械校验)。只重试 isRetryableFailure 认得的类型；
       401/KeyMissing/4xx 立即失败（配置问题，重一百次一样）。 */
    let aiResponse = ''
    let rawItems: ParsedTransaction[] = []
    let validItems: ParsedTransaction[] = []
    for (;;) {
      attempts++
      try {
        aiResponse = await chatCompletion(messages, 0.1, PARSE_ATTEMPT_TIMEOUT_MS, userId)
        rawItems = extractJsonArray(aiResponse)
        validItems = validateParsedItems(rawItems, anchorDate)
        /* 模型回了一个**非空**数组、却没有一条过机械校验 → 这既不是「判非账」
           （判非账是回 `[]`），也不是网络故障，是模型输出不可用：标记 parse_invalid
           并可重试。若混进 empty 分支，失败率里就永远看不出这种抖动。 */
        if (rawItems.length > 0 && validItems.length === 0) {
          throw new ParseError('模型返回的条目均不合法', 'parse_invalid')
        }
        break
      } catch (err) {
        if (attempts < PARSE_MAX_ATTEMPTS && isRetryableFailure(err)) {
          appLog('warn', 'ai', 'AI 解析失败，即将重试', {
            user_id: userId,
            attempt: attempts,
            failure_code: failureCodeOf(err),
          })
          await sleep(retryDelayMs(attempts, retryAfterMsOf(err)))
          continue
        }
        throw err
      }
    }

    if (validItems.length === 0) {
      // Log empty result
      const durationMs = Date.now() - startTime
      const logId = insertParseLog(db, {
        userId,
        rawInput: body.input,
        cleanedInput,
        aiResponse,
        parsedItems: null,
        status: 'empty',
        errorMessage: null,
        durationMs,
        failureCode: null,
        attempts,
        ...logMeta,
      })
      return {
        kind: 'empty',
        rawInput: body.input,
        logId,
        httpStatus: 200,
        /* 客户端判别语义用：`not_a_bill` = AI **判非账**（不是故障）；
           `unavailable` = AI 不可用/输出不可用（失败）。两者都不该打扰用户，
           但客户端本地计数与「重试与否」要分开。 */
        outcome: 'not_a_bill',
        message: 'AI 无法解析，请尝试手动记账',
      }
    }

    /* 归类 + 账户匹配 + 出参机械字段全部收进 lib/parse-assembly.ts：
       item 与 resolution 同源产出，下标对齐是**结构保证**（历史教训见模块 KDoc）。
       这里只留「候选 → 装配」的调用，出站校验（verify）是路径策略。 */
    const assemblyCtx = { input: body.input, categories, accounts, extras, path: 'ai' as const }
    const resolved = resolveItems(validItems, assemblyCtx)
    // 出站校验与后续所有出参都读这份纯 item 视图（resolution 不进响应，形状不变）
    const result = resolved.map((r) => r.item)

    // ═══ 出站校验（方案 B）═══════════════════════════════
    // 只丢「确定是噪声」的形态，不动「看起来像真交易」的。
    // 判定依据是文本形态，不是金额佐证——
    // `订单已消费 您的订单【小铁台球】39.9…已成功消费` 里的 39.9 后面没有货币单位，
    // 但它是一笔真实消费（线上已落地），必须放行给客户端。
    const verifyStart = Date.now()
    const verified = verifyParsed(
      body.input,
      result,
      requiresCorroboration(classification),
    )
    // 同样只记「判定耗时」（纯字符串/正则），不含上游模型调用
    const verifyMs = Date.now() - verifyStart
    if (verified.verdict === 'drop') {
      recordFiltered(db, {
        userId,
        rawInput: body.input,
        cleanedInput,
        stage: 'outbound',
        tier: classification.tier,
        reasons: [verified.reason],
        durationMs: verifyMs,
        channel: body.channel ?? null,
        sourcePackage: body.source?.package_name ?? null,
      })
      return {
        kind: 'filtered',
        source: 'postfilter',
        rawInput: body.input,
        outcome: 'not_a_bill',
        message: '',
      }
    }

    // Log success
    const durationMs = Date.now() - startTime

    /* §6：既有键一字不改，只追加机械字段。
       `source` 补 `'ai'`（#4 原先缺失）。needs_review/confidence 用 verifyParsed
       的**逐项**判定 + 分类是否精确命中 + classifyNotification 的 reasons。 */
    const items = finalizeItems(resolved, {
      ...assemblyCtx,
      classifyReasons: classification.reasons,
      verifyPerItem: verified.perItem,
    })

    const logId = insertParseLog(db, {
      userId,
      rawInput: body.input,
      cleanedInput,
      aiResponse,
      parsedItems: JSON.stringify(items),
      status: 'success',
      errorMessage: null,
      durationMs,
      failureCode: null,
      attempts,
      ...logMeta,
    })

    /* 一次解析只回一笔（同上）：指纹只记**客户端真正会入账的那一笔**，
       否则被裁掉的笔会留在指纹里，之后误关联到别的账单。 */
    const picked = pickMainItem(items, body.input)

    rememberParse(userId, logId, (picked.main ? [picked.main] : []) as any, body.input)

    return {
      kind: 'parsed',
      source: 'ai',
      items: picked.main ? [picked.main] : [],
      droppedCount: picked.droppedCount,
      rawInput: body.input,
      logId,
      hintsConflict,
    }
  } catch (err) {
    if (err instanceof AiError) {
      // Log AI error
      const durationMs = Date.now() - startTime
      const rawInput = (rawBody as any)?.input || ''
      const status = err.type === 'AI_TIMEOUT' ? 'timeout' : 'error'

      insertParseLog(db, {
        userId,
        rawInput,
        cleanedInput: null,
        aiResponse: null,
        parsedItems: null,
        status,
        errorMessage: `${err.type}: ${err.message}`,
        durationMs,
        failureCode: failureCodeOf(err),
        attempts,
        ...readParseMeta(rawBody),
      })

      const httpStatus = err.type === 'AI_TIMEOUT' ? 504 : 502
      return { kind: 'ai_error', message: err.message, httpStatus, outcome: 'unavailable', rawInput }
    }
    if (err instanceof ParseError) {
      // Log parse error
      const durationMs = Date.now() - startTime
      const rawInput = (rawBody as any)?.input || ''

      insertParseLog(db, {
        userId,
        rawInput,
        cleanedInput: null,
        aiResponse: null,
        parsedItems: null,
        status: 'error',
        errorMessage: `ParseError: ${err.message}`,
        durationMs,
        failureCode: failureCodeOf(err),
        attempts,
        ...readParseMeta(rawBody),
      })

      return {
        kind: 'parse_error',
        httpStatus: 200,
        outcome: 'unavailable',
        message: 'AI 返回格式异常，请尝试手动记账',
        rawInput,
      }
    }
    throw err
  }
}
