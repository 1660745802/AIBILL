/**
 * 快捷本地解析器
 * 对极简输入直接正则匹配，不走 AI，毫秒级响应
 *
 * 覆盖模式：
 * - "午饭32" / "咖啡 18" / "打车15.5"
 * - "午饭32微信" / "打车15支付宝"
 * - "午饭32，咖啡18，地铁4"（逗号分隔多笔）
 * - "发工资12000" / "收到红包200"
 *
 * 不覆盖（交给 AI）：
 * - 包含日期（"昨天午饭32"）
 * - 包含转账（"微信转支付宝500"）
 * - 长文本（>40字）
 * - 无法识别金额
 */

interface QuickParsedItem {
  type: 'expense' | 'income'
  amount: number // 元
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

// 收入关键词
const INCOME_KEYWORDS = ['工资', '薪资', '收入', '奖金', '红包', '退款', '报销', '到账', '兼职', '理财收益', '利息']

// 描述→分类映射（高频场景覆盖）
const DESC_TO_CATEGORY: Array<[RegExp, string]> = [
  [/早餐|早饭|早点/, '餐饮'],
  [/午餐|午饭|午饭/, '餐饮'],
  [/晚餐|晚饭|夜宵|宵夜/, '餐饮'],
  [/外卖|堂食|食堂|饭|菜/, '餐饮'],
  [/奶茶|咖啡|茶|饮料|果汁|水/, '餐饮'],
  [/零食|水果|面包|蛋糕/, '餐饮'],
  [/打车|出租|滴滴|快车|专车|顺风车/, '交通'],
  [/地铁|公交|公交卡|骑行|共享单车/, '交通'],
  [/加油|停车|过路费|高速/, '交通'],
  [/火车|机票|飞机|高铁|动车/, '交通'],
  [/超市|商场|网购|淘宝|京东|拼多多/, '购物'],
  [/衣服|裤子|鞋|包|服装/, '服饰'],
  [/话费|流量|宽带|网费/, '通讯'],
  [/房租|水电|物业|暖气/, '住房'],
  [/电影|游戏|视频|音乐|KTV|唱歌/, '娱乐'],
  [/药|医院|挂号|看病|体检/, '医疗'],
  [/书|课|培训|学费/, '教育'],
  [/日用品|纸巾|洗衣液|牙膏/, '日用'],
  [/红包|礼物|份子|请客|聚餐/, '人情'],
]

// 账户关键词
const ACCOUNT_KEYWORDS: Array<[RegExp, string]> = [
  [/微信|wx/, '微信'],
  [/支付宝|zfb|alipay/, '支付宝'],
  [/现金/, '现金'],
  [/银行卡|银行|刷卡/, '银行卡'],
]

/**
 * 尝试快捷解析。如果能解析返回结果，否则返回 null（交给 AI）
 */
export function quickParse(input: string, ctx: QuickParseContext): QuickParsedItem[] | null {
  const trimmed = input.trim()

  // 不处理的情况
  if (trimmed.length > 40) return null
  if (/转|转账|充值/.test(trimmed)) return null
  if (/昨天|前天|今天|明天|上周|本周|[0-9]+月[0-9]+[日号]/.test(trimmed)) return null
  if (/[\n]/.test(trimmed)) return null // 多行文本交给 AI

  // 按逗号/顿号拆分多笔
  const segments = trimmed.split(/[，,、;；]+/).map((s) => s.trim()).filter(Boolean)

  const results: QuickParsedItem[] = []

  for (const seg of segments) {
    const parsed = parseSingle(seg, ctx)
    if (!parsed) return null // 有一条解析失败就全部交给 AI
    results.push(parsed)
  }

  return results.length > 0 ? results : null
}

/**
 * 解析单条输入
 * 模式: [描述][金额][账户?]
 */
function parseSingle(input: string, ctx: QuickParseContext): QuickParsedItem | null {
  // 提取金额 — 匹配浮点数或整数
  const amountMatch = input.match(/(\d+\.?\d*)(?:元|块|¥)?/)
  if (!amountMatch) return null

  const amount = parseFloat(amountMatch[1]!)
  if (!amount || amount <= 0 || amount > 1000000) return null

  // 提取描述 — 金额前面的部分
  const amountIndex = input.indexOf(amountMatch[0]!)
  let description = input.slice(0, amountIndex).trim()
  const afterAmount = input.slice(amountIndex + amountMatch[0]!.length).trim()

  // 清理描述中的符号
  description = description.replace(/[¥￥元块钱]$/g, '').trim()

  if (!description) {
    // 尝试从金额后面取描述
    description = afterAmount.replace(/[¥￥元块钱]/g, '').trim()
  }

  if (!description) return null // 没有描述，无法判断
  if (description.length > 15) return null // 描述太长，可能是复杂文本

  // 判断收入/支出
  const isIncome = INCOME_KEYWORDS.some((kw) => description.includes(kw))
  const type: 'expense' | 'income' = isIncome ? 'income' : 'expense'

  // 匹配分类
  let category = ''
  if (isIncome) {
    // 收入分类匹配
    if (/工资|薪资/.test(description)) category = '工资'
    else if (/奖金|年终/.test(description)) category = '奖金'
    else if (/红包/.test(description)) category = '红包'
    else if (/退款|报销|退货/.test(description)) category = '退款'
    else if (/理财|利息|收益/.test(description)) category = '理财'
    else if (/兼职/.test(description)) category = '兼职'
    else category = '其他'
  } else {
    for (const [pattern, cat] of DESC_TO_CATEGORY) {
      if (pattern.test(description)) {
        category = cat
        break
      }
    }
    if (!category) category = '其他'
  }

  // 验证分类存在于用户分类列表
  const availableCategories = type === 'expense' ? ctx.expenseCategories : ctx.incomeCategories
  if (!availableCategories.includes(category)) {
    category = availableCategories.includes('其他') ? '其他' : (availableCategories[0] || '其他')
  }

  // 匹配账户（从剩余文本中提取）
  let account = ''
  const fullText = description + afterAmount
  for (const [pattern, accName] of ACCOUNT_KEYWORDS) {
    if (pattern.test(fullText)) {
      // 验证用户有这个账户
      if (ctx.accounts.includes(accName)) {
        account = accName
      }
      break
    }
  }

  // 如果描述里包含账户名，从描述中去掉
  if (account && description.includes(account)) {
    description = description.replace(account, '').trim()
  }

  return {
    type,
    amount,
    description: description.slice(0, 10),
    category,
    account,
    date: ctx.today,
  }
}
