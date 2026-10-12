/**
 * 「一次解析只回一笔」的挑笔器（产品决定：**取消批量记账**）
 *
 * 为什么需要它：模型可能回多笔（长短信、A11Y 整页文本、含「共N笔」的汇总通知），
 * 而契约现在保证**一次解析 = 一笔**。挑笔标准必须是**服务端唯一实现**——
 * 客户端曾自己搞 `aiItemScore` + `maxByOrNull`（一套分数、一套口径），
 * 两边标准不同就是两套口径，且客户端那套是**静默丢弃**其余笔（丢账不告知）。
 *
 * 标准（按优先级，全是机械判据，不看模型自述）：
 *   ① **金额在原文里带货币单位佐证**（`hasCorroboration`）——有佐证的才是「真发生的钱」
 *   ② **信息完整度高**：分类（转账不需要）/ 账户 / 描述 / 日期 各计 1 分
 *   ③ **金额降序**
 *   ④ 保持模型返回的**原序**（确定性：同一输入必得同一笔，便于测试与排障）
 *
 * 被裁掉的笔数由调用方回给客户端（`extra_items_dropped`），**不静默**；
 * 全部条目仍写进 `ai_parse_logs.parsed_items`，服务端保留可诊断的完整现场。
 */
import { hasCorroboration } from '../ai/verify.js'

export interface MainItemLike {
  type: string
  amount: number
  category_id?: number | null
  account_id?: number | null
  description?: string | null
  date?: string | null
}

/** 信息完整度 0~4：分类（转账免）/ 账户 / 描述 / 日期 */
function completeness(it: MainItemLike): number {
  return (
    (it.category_id != null || it.type === 'transfer' ? 1 : 0) +
    (it.account_id != null ? 1 : 0) +
    (typeof it.description === 'string' && it.description.trim().length > 0 ? 1 : 0) +
    (typeof it.date === 'string' && it.date.trim().length > 0 ? 1 : 0)
  )
}

/**
 * 从候选里挑「主笔」。返回 `main = null` 仅当输入为空；
 * `droppedCount` = 因这次挑选被裁掉的条数（0 表示没有裁剪）。
 */
export function pickMainItem<T extends MainItemLike>(
  items: T[],
  rawInput: string,
): { main: T | null; droppedCount: number } {
  if (items.length === 0) return { main: null, droppedCount: 0 }
  if (items.length === 1) return { main: items[0]!, droppedCount: 0 }

  let bestIdx = 0
  let bestCorroborated = -1
  let bestComplete = -1
  let bestAmount = -1
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!
    const corroborated = hasCorroboration(rawInput, it.amount) ? 1 : 0
    const complete = completeness(it)
    const better =
      corroborated > bestCorroborated ||
      (corroborated === bestCorroborated &&
        (complete > bestComplete ||
          (complete === bestComplete && it.amount > bestAmount)))
    if (better) {
      bestIdx = i
      bestCorroborated = corroborated
      bestComplete = complete
      bestAmount = it.amount
    }
  }
  return { main: items[bestIdx]!, droppedCount: items.length - 1 }
}
