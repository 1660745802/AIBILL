/**
 * 与后端契约对齐的共享类型。
 *
 * ## 为什么要有这个文件
 *
 * 之前 `interface Transaction` 在 3 个文件里各写一份、`interface Account` 在 2 个
 * 文件里各写一份，同名不同形（Trash 缺 `category_id`、Ledger 缺 `deleted_at`…）。
 * 手写副本必然漂移，而 `tsconfig` 开着 `strict` 也救不了——副本本身就是真相。
 *
 * 这里的字段**不是猜的**，是对着下面这些源头抄的：
 *   - `server/src/db/schema.ts`       建表 / ALTER 列，决定可空性
 *   - `server/src/routes/transaction.ts`  列表接口 `SELECT t.*` + 3 个 LEFT JOIN
 *   - `server/src/routes/account.ts`      `SELECT a.*, a.balance AS current_balance`
 *   - `server/src/lib/portfolio.ts`       AccountPosition（camelCase）
 *
 * 口径提醒：**金额一律是「分」**，别在前端当元用。
 *
 * 注意：这些类型只描述**响应形状**。因为 `/api/transactions` 的列表是
 * `SELECT t.*`，所有列都会回来（不存在时才为 null），所以这里不用把展示字段
 * 标成 optional——那正是旧的 3 份副本互相打架的原因。
 */

/** 统一响应信封，见 docs/API.md §0.1 */
export interface ApiResponse<T> {
  code: number
  data: T
  message: string
}

/** 交易类型，与 schema 的 CHECK 约束一致 */
export type TransactionType = 'expense' | 'income' | 'transfer'

/**
 * 一笔交易。
 *
 * `deleted_at` 非 null 表示在回收站里（软删，不计入统计）。
 */
export interface Transaction {
  id: number
  /** 金额，分。正整数（schema: amount > 0） */
  amount: number
  type: TransactionType
  /** 可空：转账和未填备注的记录都是 NULL */
  description: string | null
  /** 业务日期 YYYY-MM-DD，与 created_at 不是一回事 */
  date: string
  /** HH:mm，可空 */
  time: string | null
  category_id: number | null
  account_id: number | null
  /** 仅 transfer 有值 */
  target_account_id: number | null
  /** JSON 数组字符串（如 '["餐饮","报销"]'），不是数组——渲染前要 parse */
  tags: string
  /** pending 不计入统计 */
  status: 'confirmed' | 'pending'
  /** 记账来源：manual / ai / import_csv / app_notification / ocr / subscription */
  source: string
  deleted_at: string | null

  /* ↓ 以下来自 LEFT JOIN，关联对象不存在时为 null ↓ */
  category_name: string | null
  category_icon: string | null
  account_name: string | null
  target_account_name: string | null
}

/**
 * 账户。
 *
 * `/api/accounts` 返回 `a.*` 外加一个别名 `current_balance`（与 `balance` 同值）。
 * 两个字段都留着：改名任何一边都会静默变成 undefined。
 */
export interface Account {
  id: number
  name: string
  icon: string
  /** 老分类字段：cash / wechat / alipay / bank / credit / other */
  type: string
  /** 展示分组：liquid / savings / investment / credit / loan / property / other */
  asset_type: string | null
  currency: string
  /** 余额，分。017 之后的单一真源 */
  balance: number
  /** `balance` 的别名，见上 */
  current_balance: number
  /** 账户级总投入，分。null = 没填过，此时不该显示盈亏 */
  invested_total: number | null
  credit_limit: number
  billing_day: number
  due_day: number
  note: string | null
  is_active: number
  sort_order: number
  /** 注意可空：schema 没加 NOT NULL */
  initial_balance: number | null
}

/**
 * 投资工作台里的一个账户（`/api/assets/portfolio` → `data.accounts[]`）。
 *
 * 口径见 `server/src/lib/portfolio.ts` 的 AccountPosition，有三条容易踩：
 *   1. `value` = 持仓市值 + 现金；行情缺失时为 **null 而不是 0**
 *      （0 会被读成「持仓归零了」）
 *   2. `lastUpdated` null = 从没填过快照，不是「今天」
 *   3. `unrealized` 三个条件缺一不可，否则也是 null——别拿 0 顶替
 */
export interface PortfolioPosition {
  accountId: number
  name: string
  assetType: string
  isInvestment: boolean
  /** 负余额 = 负债（信用卡欠款） */
  isDebt: boolean
  /** 该账户挂了持仓 ⇒ `cash` 要当现金读，不能当账户总值 */
  hasHoldings: boolean
  /** 有净投入但还没配持仓：显示「持仓未配置」，不显示盈亏 */
  holdingsPending: boolean
  /** 现金余额，分 */
  cash: number
  /** 持仓市值，分。无持仓为 0，行情缺失为 null */
  holdingsValue: number | null
  /** 账户总价值 = 持仓市值 + 现金，分。行情缺失时 null */
  value: number | null
  /** 账户级总投入，分 */
  totalInvested: number | null
  /** 最新快照日期；null = 从没填过 */
  lastUpdated: string | null
  /** 距今天数；null = 从没填过 */
  staleDays: number | null
  /** 浮动盈亏，分。算不出时为 null */
  unrealized: number | null
  /** 浮动收益率，算不出时为 null */
  unrealizedRate: number | null
}