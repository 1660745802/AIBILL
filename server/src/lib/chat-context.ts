/**
 * 问答（`POST /api/ai/chat`）喂给模型的**数据上下文**
 *
 * 四段拼成：当月+上月收支摘要 → 本月支出分类 Top10 → 最近 30 笔交易明细 →
 * 用户偏好记忆（仅 `source='manual'`）。返回的两段由路由按
 * `${dataContext}${memoryContext}` 拼进 system prompt 的 `<user_data>` 区块。
 *
 * ⚠️ **文本逐字不动**：这里产出的是**进 prompt 的内容**，多一个字、改一个标点
 * 都是改模型行为（ARCHITECTURE §5.4）。只搬位置，不改内容。
 *
 * 注入面说明（原路由注释，随代码搬来）：`dataContext` 里的**交易描述**来自导入的
 * 第三方账单/通知文本（商户名/备注），它们以「数据」身份拼进 system prompt，却和指令
 * 同处一个文本块 → 由路由包进 `<user_data>` 并声明其中的内容不得当指令执行。
 */
import { beijingYearMonth } from './date.js'
import type { getDb } from '../db/index.js'

type Db = ReturnType<typeof getDb>

export interface ChatContext {
  /** 财务摘要 + 分类明细 + 最近 30 笔（不含记忆） */
  dataContext: string
  /** 用户偏好记忆块；无记忆时为空串 */
  memoryContext: string
}

export function buildChatContext(db: Db, userId: number): ChatContext {
  // 获取用户财务数据摘要（当月+上月）
  const bjm = beijingYearMonth()
  const thisMonth = `${bjm.year}-${String(bjm.month).padStart(2, '0')}`
  const prevDate = new Date(bjm.year, bjm.month - 2, 1)
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`

  const summaryData = db
    .prepare(
      `SELECT
        substr(date, 1, 7) as month,
        type,
        SUM(amount) as total,
        COUNT(*) as count
       FROM transactions
       WHERE user_id = ? AND status = 'confirmed' AND deleted_at IS NULL
         AND type IN ('expense', 'income')
         AND substr(date, 1, 7) IN (?, ?)
       GROUP BY substr(date, 1, 7), type`,
    )
    .all(userId, thisMonth, prevMonth) as Array<{ month: string; type: string; total: number; count: number }>

  const categorySummary = db
    .prepare(
      `SELECT c.name, SUM(t.amount) as total, COUNT(*) as count
       FROM transactions t
       JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
         AND t.type = 'expense'
         AND substr(t.date, 1, 7) = ?
       GROUP BY t.category_id
       ORDER BY total DESC
       LIMIT 10`,
    )
    .all(userId, thisMonth) as Array<{ name: string; total: number; count: number }>

  // 构建数据上下文
  const contextLines: string[] = ['用户财务数据摘要：']
  for (const row of summaryData) {
    const amount = (row.total / 100).toFixed(2)
    contextLines.push(`${row.month} ${row.type === 'expense' ? '支出' : '收入'}: ¥${amount}（${row.count}笔）`)
  }
  if (categorySummary.length > 0) {
    contextLines.push(`\n本月支出分类明细：`)
    for (const cat of categorySummary) {
      contextLines.push(`  ${cat.name}: ¥${(cat.total / 100).toFixed(2)}（${cat.count}笔）`)
    }
  }

  // 注入最近交易明细（支持用户问具体问题）
  const recentTransactions = db
    .prepare(
      `SELECT t.date, t.type, t.amount, t.description, c.name as category_name
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.status = 'confirmed' AND t.deleted_at IS NULL
       ORDER BY t.date DESC, t.created_at DESC
       LIMIT 30`,
    )
    .all(userId) as Array<{ date: string; type: string; amount: number; description: string; category_name: string | null }>

  if (recentTransactions.length > 0) {
    contextLines.push(`\n最近交易明细（最新30笔）：`)
    contextLines.push('日期 | 类型 | 金额 | 描述 | 分类')
    for (const tx of recentTransactions) {
      const typeLabel = tx.type === 'expense' ? '支出' : tx.type === 'income' ? '收入' : '转账'
      contextLines.push(`${tx.date} | ${typeLabel} | ¥${(tx.amount / 100).toFixed(2)} | ${tx.description || '-'} | ${tx.category_name || '-'}`)
    }
  }

  const dataContext = contextLines.join('\n')

  // 查询用户偏好记忆
  // ⚠️ **只取 source='manual'**（与 /ai/parse 同口径；DATA §3.2 / API.md §3 / ARCHITECTURE §5.4）：
  // 注入只允许来自用户自己确认的偏好。`ai_suggested`（解析修正自动学习）的**写入**路径
  // 已随 `parse-feedback` 下线移除，但历史行仍在表里——过滤与措辞都不放宽。
  const memories = db
    .prepare(
      "SELECT content FROM ai_memories WHERE user_id = ? AND is_active = 1 AND source = 'manual' ORDER BY created_at DESC LIMIT 20",
    )
    .all(userId) as Array<{ content: string }>

  let memoryContext = ''
  if (memories.length > 0) {
    const memoryLines = memories.map((m) => `- ${m.content}`).join('\n')
    memoryContext = `\n\n## 用户偏好记忆\n${memoryLines}`
  }

  return { dataContext, memoryContext }
}
