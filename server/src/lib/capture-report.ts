/**
 * 客户端拦截内容采集（契约 docs/API.md 附录 C §11.3 / §11.4）
 *
 * 把客户端在**本地**丢掉的样本（结构摘要 + 命中片段；P1 默认带原文）落进
 * `client_capture_samples`，供 admin review 与规则收敛。与 ⑤ 的聚合计数
 * （`client_filter_stats`）**分开存**：计数回答「拦了多少」，样本回答「拦的是什么」。
 *
 * 硬边界（§11.5）：**绝不写 `transactions`、绝不调 AI、绝不回推客户端**。
 * 与 `POST /api/ai/parse` 的通道 B 无关——那条走服务端预筛（落 `ai_parse_filters`）。
 *
 * 本模块**碰 DB、不碰 HTTP**：入参校验（zod）与窗口归一在路由，这里只拿已校验的样本。
 * 沿 `parse-pipeline` 的薄路由 + 深 module 做法：路由只负责「翻译」，落库全在这里。
 */
import type { getDb } from '../db/index.js'

type Db = ReturnType<typeof getDb>

/** 采样渠道（契约 §11.3）：只有三渠道，`manual` 不存在（手输没有「被拦」这回事） */
export const CAPTURE_CHANNELS = ['nls', 'sms', 'a11y'] as const
export type CaptureChannel = (typeof CAPTURE_CHANNELS)[number]

/** 样本形态：通知 / 无障碍整页 */
export const CAPTURE_KINDS = ['notification', 'a11y_page'] as const
export type CaptureKind = (typeof CAPTURE_KINDS)[number]

/** 在哪一层丢的：捕获层早退 / 预筛判据拦下 */
export const CAPTURE_STAGES = ['capture', 'prefilter'] as const
export type CaptureStage = (typeof CAPTURE_STAGES)[number]

/** 一条样本（已通过路由的 zod 校验）。 */
export interface CaptureSample {
  channel: CaptureChannel
  /** 包名；SMS 是 `sms:<号码>`（与审计记录同口径） */
  package: string
  kind: CaptureKind
  stage: CaptureStage
  /** 命中/触发的规则或丢弃点 id，**与 ⑤ 上报同源**（`client_only.` + `CaptureFunnelStats.reportKey`），
   * 如 `client_only.capture_dropped_a11y_not_whitelisted`、`client_only.marketing`。 */
  blocked_by: string
  tier?: number
  received_at?: string
  /** P1 默认原文；`redacted=true` 时为脱敏预览 */
  text?: string
  text_len?: number
  /** 客户端算的样本指纹（去重键的一半） */
  content_hash: string
  redacted?: boolean
}

export interface CaptureReportInput {
  userId: number
  clientVersion: string
  samples: readonly CaptureSample[]
}

export interface CaptureReportResult {
  /** 本次真正新落库的条数 */
  accepted: number
  /** 命中 `UNIQUE(user_id, content_hash, blocked_by)` 被忽略的条数 */
  duplicates: number
}

/**
 * 把一批样本落进 `client_capture_samples`。
 *
 * 幂等靠表上的 `UNIQUE(user_id, content_hash, blocked_by)` + `ON CONFLICT DO NOTHING`：
 * 客户端 best-effort 重发同一窗口时只累 `duplicates`，不产生重复行。
 * 同一 `content_hash` 命中不同 `blocked_by` 是**两条**（一笔可能被多条规则同时解释），
 * 所以去重键含 `blocked_by`。
 *
 * 一批放在一个事务里：不留「半批落库」（异常时整批回滚）。
 *
 * `text_len` 缺省时按 `text.length` 补（admin 列表要按长度排序/筛，缺了就没法排）。
 */
export function saveCaptureReport(db: Db, input: CaptureReportInput): CaptureReportResult {
  const insert = db.prepare(
    `INSERT INTO client_capture_samples
       (user_id, client_version, channel, package, kind, stage, blocked_by, tier, received_at, text, text_len, content_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, content_hash, blocked_by) DO NOTHING`,
  )

  let accepted = 0
  let duplicates = 0
  db.transaction(() => {
    for (const s of input.samples) {
      const textLen = s.text_len ?? (typeof s.text === 'string' ? s.text.length : null)
      const res = insert.run(
        input.userId,
        input.clientVersion,
        s.channel,
        s.package,
        s.kind,
        s.stage,
        s.blocked_by,
        s.tier ?? null,
        s.received_at ?? null,
        s.text ?? null,
        textLen,
        s.content_hash,
      )
      if (res.changes > 0) accepted++
      else duplicates++
    }
  })()

  return { accepted, duplicates }
}
