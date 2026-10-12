/**
 * 订阅费用的「月 / 年折算」——**全仓唯一实现**。
 *
 * 同一件事以前在三个地方各写了一遍，而且**两种舍入顺序**：
 *
 * | 位置 | 做法 |
 * |---|---|
 * | `GET /api/subscriptions` | 逐条 `Math.round(amount / 3)`、`Math.round(amount / 12)` 再相加 |
 * | `GET /api/stats/dashboard` | SQL 里 `SUM(amount / 3.0)` 之后统一 `Math.round` |
 * | `POST /api/stats/analysis` | `SUM(amount / 3)`，不取整，浮点写进提示词 |
 *
 * 于是同一份数据能出两个数：两笔季度 ¥100 → 列表给 `33 + 33 = 66`，
 * 仪表给 `round(200 / 3) = 67`。这正是本项目反复踩的「同一个数字两套算法」。
 *
 * ## 选的口径：**先按精确值折算求和，最后统一取整一次**
 *
 * 逐条取整会把每条的小数部分各自抹掉，误差随订阅数线性累加（N 条最坏差 N×0.5 分）；
 * 先求和只丢一次小数部分，误差恒 ≤ 0.5 分，也更接近「这些订阅每月一共要花多少」。
 *
 * 年费是整数运算（`amount * 12 / months`：monthly→×12、quarterly→×4、yearly→×1），
 * 所以 `yearlyTotal` 是精确值，不存在舍入。
 */

/** 一个周期等于几个月 */
const MONTHS_PER_CYCLE: Record<string, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
}

export interface SubscriptionCostRow {
  /** 单期金额（分） */
  amount: number
  /** monthly | quarterly | yearly */
  cycle: string
}

export interface SubscriptionCost {
  /** 折算成每月多少（分），四舍五入 */
  monthlyTotal: number
  /** 折算成每年多少（分），精确值 */
  yearlyTotal: number
}

/**
 * 把一批订阅（调用方自行过滤 `status='active'`）折算成月/年总额。
 * 未知 `cycle` 直接跳过——不猜、也不当成按月。
 */
export function subscriptionCosts(rows: SubscriptionCostRow[]): SubscriptionCost {
  let monthly = 0
  let yearly = 0
  for (const r of rows) {
    const months = MONTHS_PER_CYCLE[r.cycle]
    if (months == null) continue
    monthly += r.amount / months
    yearly += (r.amount * 12) / months
  }
  return { monthlyTotal: Math.round(monthly), yearlyTotal: Math.round(yearly) }
}
