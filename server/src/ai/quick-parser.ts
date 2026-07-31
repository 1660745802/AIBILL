/**
 * 快捷本地解析器（保守策略）
 *
 * 设计原则：宁可多走一次 AI，也不要分错类给用户。
 * 只在"极高置信度"时才走本地，否则一律交给 AI。
 *
 * 高置信模式（覆盖日常 60% 的记账输入）：
 * - 精确匹配用户的分类名 + 金额："餐饮32"、"交通15"
 * - 精确匹配同义词表 + 金额："午饭32"、"打车15"、"咖啡18"
 * - 以上 + 账户名："午饭32微信"
 * - 逗号分隔多笔（每笔都能高置信匹配）
 *
 * 低置信（交给 AI）：
 * - 描述词不在同义词表里："肯德基45"、"小米商城299"
 * - 有日期/时间信息
 * - 有转账/还款关键词
 * - 长文本
 */

interface QuickParsedItem {
  type: 'expense' | 'income'
  amount: number
  description: string
  category: string
  account: string
  date: string
}

interface QuickParseContext {
  today: string
  expenseCategories: string[]
  incomeCategories: string[]
  accounts: string[]
}

// 高置信同义词：key 是用户可能输入的词，value 是分类名
// 只收录"一定不会错"的映射
const HIGH_CONFIDENCE_MAP: Record<string, { category: string; type: 'expense' | 'income' }> = {
  // 餐饮（最高频）
  早餐: { category: '餐饮', type: 'expense' },
  早饭: { category: '餐饮', type: 'expense' },
  午餐: { category: '餐饮', type: 'expense' },
  午饭: { category: '餐饮', type: 'expense' },
  晚餐: { category: '餐饮', type: 'expense' },
  晚饭: { category: '餐饮', type: 'expense' },
  夜宵: { category: '餐饮', type: 'expense' },
  外卖: { category: '餐饮', type: 'expense' },
  奶茶: { category: '餐饮', type: 'expense' },
  咖啡: { category: '餐饮', type: 'expense' },
  饮料: { category: '餐饮', type: 'expense' },
  水果: { category: '餐饮', type: 'expense' },
  零食: { category: '餐饮', type: 'expense' },
  食堂: { category: '餐饮', type: 'expense' },
  // 交通
  打车: { category: '交通', type: 'expense' },
  地铁: { category: '交通', type: 'expense' },
  公交: { category: '交通', type: 'expense' },
  加油: { category: '交通', type: 'expense' },
  停车: { category: '交通', type: 'expense' },
  // 通讯
  话费: { category: '通讯', type: 'expense' },
  // 收入
  工资: { category: '工资', type: 'income' },
  薪资: { category: '工资', type: 'income' },
  奖金: { category: '奖金', type: 'income' },
  红包: { category: '红包', type: 'income' },
  退款: { category: '退款', type: 'income' },
}

// 账户关键词（只匹配尾部出现的）
const ACCOUNT_SUFFIXES: Record<string, string> = {
  微信: '微信',
  支付宝: '支付宝',
  现金: '现金',
  银行卡: '银行卡',
}

/**
 * 尝试快捷解析。
 * 返回结果 = 高置信匹配成功
 * 返回 null = 交给 AI
 */
export function quickParse(input: string, ctx: QuickParseContext): QuickParsedItem[] | null {
  const trimmed = input.trim()

  // 基本排除规则
  if (trimmed.length > 30) return null
  if (trimmed.length < 2) return null
  if (/转|转账|充值|还/.test(trimmed)) return null
  if (/昨天|前天|今天|明天|上周|本周|下周|[0-9]+月[0-9]+[日号]/.test(trimmed)) return null
  if (/\n/.test(trimmed)) return null

  // 按逗号/顿号拆分多笔
  const segments = trimmed.split(/[，,、;；]+/).map((s) => s.trim()).filter(Boolean)
  if (segments.length > 5) return null // 太多条交给 AI

  const results: QuickParsedItem[] = []

  for (const seg of segments) {
    const parsed = parseSingle(seg, ctx)
    if (!parsed) return null // 有一条不确定就全部交给 AI
    results.push(parsed)
  }

  return results.length > 0 ? results : null
}

/**
 * 解析单条。只在高置信时返回结果。
 */
function parseSingle(input: string, ctx: QuickParseContext): QuickParsedItem | null {
  // 提取金额（必须有数字）
  const amountMatch = input.match(/(\d+\.?\d*)/)
  if (!amountMatch) return null

  const amount = parseFloat(amountMatch[1]!)
  if (!amount || amount <= 0 || amount > 500000) return null

  // 去掉金额部分，剩下的是描述 + 可能的账户
  const amountIndex = input.indexOf(amountMatch[0]!)
  const beforeAmount = input.slice(0, amountIndex).replace(/[¥￥元块钱\s]/g, '').trim()
  const afterAmount = input.slice(amountIndex + amountMatch[0]!.length).replace(/[¥￥元块钱\s]/g, '').trim()

  // 描述在金额前面
  let description = beforeAmount
  let trailing = afterAmount

  // 如果描述为空，尝试金额后面
  if (!description && trailing) {
    description = trailing
    trailing = ''
  }

  if (!description) return null
  if (description.length > 8) return null // 描述太长不确定

  // 尝试从尾部提取账户
  let account = ''
  const fullTrailing = trailing || ''
  for (const [keyword, accName] of Object.entries(ACCOUNT_SUFFIXES)) {
    if (fullTrailing === keyword || description.endsWith(keyword)) {
      if (ctx.accounts.includes(accName)) {
        account = accName
        // 从描述中去掉账户名
        if (description.endsWith(keyword)) {
          description = description.slice(0, -keyword.length)
        }
      }
      break
    }
  }

  if (!description) return null

  // 核心判断：描述必须在高置信映射表或用户分类名中
  const allCategories = [...ctx.expenseCategories, ...ctx.incomeCategories]

  // 1. 精确匹配用户分类名（用户自己建的分类名就是最高置信）
  if (allCategories.includes(description)) {
    const isIncome = ctx.incomeCategories.includes(description)
    return {
      type: isIncome ? 'income' : 'expense',
      amount,
      description,
      category: description,
      account,
      date: ctx.today,
    }
  }

  // 2. 高置信同义词表匹配
  const mapped = HIGH_CONFIDENCE_MAP[description]
  if (mapped) {
    // 验证分类存在于用户列表
    const available = mapped.type === 'expense' ? ctx.expenseCategories : ctx.incomeCategories
    if (available.includes(mapped.category)) {
      return {
        type: mapped.type,
        amount,
        description,
        category: mapped.category,
        account,
        date: ctx.today,
      }
    }
  }

  // 没有高置信匹配 → 返回 null，交给 AI
  return null
}
