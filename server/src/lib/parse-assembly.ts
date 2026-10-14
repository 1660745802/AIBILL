/**
 * 解析装配（ParseAssembly）
 *
 * 「候选 → 响应 item」的**唯一实现**。quick（本地正则）与 ai（模型）两条入口
 * 各自产出候选，之后一律走这里：归类、分类行回查、账户匹配、§6 机械字段、
 * needs_review/confidence、噪声审计。它们此前在 `routes/ai.ts` 里各写了一份，
 * 并已漂移（quick 账户只精确匹配、ai 模糊包含；quick 不参与 verify）。
 *
 * 本模块不碰 DB / HTTP：分类与账户清单由调用方按 `user_id` 查好传进来，
 * 「今天」也由调用方锚定（`received_at` → 北京日期）。因此可纯函数单测。
 *
 * 两个阶段（出站校验夹在中间，它是**路径策略**，不在这里）：
 *   `resolveItems`  候选 → { item(纯形状), resolution(归类自描述) }
 *   `finalizeItems` 挂 extras / meta / 噪声审计 → 响应 item
 *
 * ai 路径在两者之间跑 `verifyParsed`（结果 `drop` 时整批换成 `postfilter` 响应，
 * 是另一条出口，不属于装配）；quick 路径不跑，直接 `finalizeItems`。
 *
 * 下标对齐是**结构保证**：item 与 resolution 同源产出，调用方不必再维护平行数组。
 */
import { resolveCategory, type CategoryResolution, type CategoryType } from '../ai/category-matcher.js'
import type { VerifyResult } from '../ai/verify.js'
import { deriveReviewMeta, type ParsedExtras } from './parse-extract.js'

/** 用户的活跃分类（`categories` 表一行，含 icon） */
export interface CategoryRow {
  id: number
  name: string
  type: string
  icon: string
}

/** 用户的活跃账户（`accounts` 表一行） */
export interface AccountRow {
  id: number
  name: string
}

/**
 * 一条待装配的候选。quick 与 ai 的输出都归一到这里：
 * `amount` 是**元**（装配时转分），分类/账户都是「名字」，由本模块解析成 id。
 */
export interface AssemblyCandidate {
  type: string
  amount: number
  category?: string | null
  description?: string | null
  date?: string | null
  account?: string | null
  target_account?: string | null
}

/** 装配上下文：调用方查好的用户数据 + 判据只许用的 `input`。 */
export interface AssemblyContext {
  /** 原文。tier / 佐证 / 归类判据**只许用 input**（title/body 不参与判据）。 */
  input: string
  categories: readonly CategoryRow[]
  accounts: readonly AccountRow[]
  /** §6 机械抽取结果（抽取可退回 title/body，判定不可）。 */
  extras: ParsedExtras
  path: 'quick' | 'ai'
  /** classifyNotification 的 reasons（ai 路径有；quick 为空）→ bare_amount 判据 */
  classifyReasons?: readonly string[]
  /** verifyParsed 的**逐项**判定（ai 路径有；quick 没有 verify 阶段） */
  verifyPerItem?: VerifyResult['perItem']
}

/** 未挂机械字段的纯 item 形状（出站校验读它；resolution 不进响应）。 */
export type AssembledBaseItem = {
  type: string
  amount: number
  category_id: number | null
  category_name: string
  category_icon: string
  description?: string
  date?: string
  account_id: number | null
  account_name: string
  target_account_id: number | null
  target_account_name: string
}

export interface ResolvedItem {
  item: AssembledBaseItem
  /** transfer 没有归类判定 → null；其余必是一次 `resolveCategory` 的自描述结果 */
  resolution: CategoryResolution | null
}

/** transfer 没有归类判定 → 没有噪声审计 */
function noNoiseResolution(): CategoryResolution {
  return {
    category_id: null, category_name: '', category_icon: '',
    reason: 'undetermined', reason_detail: 'transfer:不参与归类', is_exact: false, noise: null,
  }
}

/**
 * 账户匹配：**精确优先，其次双向包含**。
 *
 * **这是两条路径合并后的唯一匹配口径**（此前 quick 只精确、ai 双向包含，是重复
 * 代码的产物）。双向包含是给模型输出用的：「微信支付」应落到账户「微信」。
 *
 * ⚠️ 必须**两趟**，不能写成一趟 `find(OR)`：`find` 返回数组里**第一个**命中的项，
 * 而包含匹配比精确匹配宽——只要某个「更长的账户名」排在前面，它就会把精确项抢走
 * （`accounts=[微信, 微信支付]`、`name=微信支付` → 单趟 `find(OR)` 返回「微信」，
 * 而「微信支付」账户明明存在）。精确相等是**更强**的证据，必须赢过包含；
 * 包含只在没有精确项时才兜底。`accounts` 是 DB 查询结果，顺序不由本模块决定。
 */
function matchAccount(name: string | null | undefined, accounts: readonly AccountRow[]): AccountRow | null {
  if (!name) return null
  const exact = accounts.find((a) => a.name === name)
  if (exact) return exact
  return accounts.find((a) => a.name.includes(name) || name.includes(a.name)) ?? null
}

/**
 * 阶段一：候选 → 纯 item + 归类结果。不追加 §6 机械字段。
 *
 * ai 路径在调用本函数后、`finalizeItems` 前跑出站校验。
 */
export function resolveItems(
  candidates: readonly AssemblyCandidate[],
  ctx: AssemblyContext,
): ResolvedItem[] {
  // 分类清单只映射一次（此前每个候选都重映射一遍）
  const categories = ctx.categories.map((c) => ({
    id: c.id,
    name: c.name,
    type: c.type as CategoryType,
  }))

  return candidates.map((item) => {
    // 分类匹配（transfer 不需要分类）——无分支地算一次
    const resolution: CategoryResolution | null = item.type === 'transfer'
      ? null
      : resolveCategory({
        requested: item.category,
        type: item.type === 'expense' ? 'expense' : 'income',
        categories,
        // 判据只许用 input（不用 title/body，与 deriveReviewMeta 同口径）
        evidenceText: ctx.input,
      })
    // 用户该类型下一个分类都没有时 category_id 为 null：给契约内合法的 null，不给 id 0
    const catRow = resolution?.category_id == null
      ? undefined
      : ctx.categories.find((c) => c.id === resolution.category_id)

    const account = matchAccount(item.account, ctx.accounts)
    const target = item.type === 'transfer' ? matchAccount(item.target_account, ctx.accounts) : null

    return {
      item: {
        type: item.type,
        amount: Math.round(item.amount * 100), // 元转分
        category_id: resolution?.category_id ?? null,
        category_name: resolution?.category_name ?? '',
        category_icon: catRow ? (catRow.icon || '📦') : '',
        description: item.description ?? undefined,
        date: item.date ?? undefined,
        account_id: account?.id ?? null,
        account_name: account?.name ?? '',
        target_account_id: target?.id ?? null,
        target_account_name: target?.name ?? '',
      },
      resolution,
    }
  })
}

/**
 * 噪声闸审计字段（契约 §6：只追加机械字段，既有键一字不改）。
 *
 * **只在噪声闸真的参与过判定时才追加**——不给每一笔都塞这三个键：
 *   · `category_reason`      —— 归类理由（取 CATEGORY_REASONS）
 *   · `noise_term`           —— 命中哪个噪声词条（被窄语境判掉时非空）
 *   · `noise_verdict_source` —— `narrow` = 被噪声闸判掉；`broad` = 窄语境放过、
 *                               但 verify 的宽口径会判噪声（管理员复核对象）
 *
 * 审计需求由 `ai_parse_logs.parsed_items`（存整份 items JSON）满足，
 * **无需 migration、无需新表、不改 /api/admin/* 的响应形状**；客户端可忽略这三个键。
 */
function noiseAuditFields(res: CategoryResolution | null): Record<string, unknown> {
  const resolution = res ?? noNoiseResolution()
  if (!resolution.noise) return {}
  return {
    category_reason: resolution.reason,
    noise_term: resolution.noise.term,
    noise_verdict_source: resolution.noise.source,
  }
}

/**
 * 阶段二：挂 `extras` + `needs_review/confidence` + 噪声审计 → 响应 item。
 *
 * `needs_review` 的四个来源里，quick 路径没有 verify / bare_amount，只剩分类判据；
 * 转账视为分类精确（本就不需要分类，不因此判 needs_review）。
 */
export function finalizeItems(
  resolved: readonly ResolvedItem[],
  ctx: AssemblyContext,
): Array<AssembledBaseItem & ParsedExtras & ReturnType<typeof deriveReviewMeta>> {
  return resolved.map(({ item, resolution }, i) => {
    const categoryExact = item.type === 'transfer' ? true : (resolution?.is_exact ?? false)
    const meta = deriveReviewMeta({
      path: ctx.path,
      categoryExact,
      amountCents: item.amount,
      input: ctx.input,
      classifyReasons: ctx.classifyReasons as string[] | undefined,
      verifyVerdict: ctx.verifyPerItem?.[i]?.verdict,
    })
    return { ...item, ...ctx.extras, ...meta, ...noiseAuditFields(resolution) }
  })
}
