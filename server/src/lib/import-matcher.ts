/**
 * CSV 账单导入辅助：分类预填 + 重复检测
 *
 * 背景：微信/支付宝导出的原始描述（如“美团”“滴滴出行-XX”）无法直接对应用户的
 * 分类体系。之前导入的记录 category_id 全为 NULL，导致：
 *   1. 分类统计（JOIN categories）完全看不到导入数据
 *   2. 按分类的预算回溯失效
 *   3. AI 财务分析的分类明细缺失
 *
 * 设计取舍：规则表命中就预填（省点击），但**允许用户在预览中改**——
 * 宁可让用户确认，也不要用错误分类污染统计。
 */
import type Database from 'better-sqlite3'

export interface ImportCandidate {
  type: 'expense' | 'income' | 'transfer'
  /** 分 */
  amount: number
  description: string
  /** YYYY-MM-DD */
  date: string
  /** 形如「微信-美团」 */
  source_detail: string
  category_id: number | null
  category_name: string | null
  category_icon: string | null
  /** 是否由规则表自动匹配（UI 可据此提示“可修改”） */
  category_auto: boolean
  /** 与已有记录重复 */
  duplicate: boolean
}

interface UserCategory {
  id: number
  name: string
  type: 'expense' | 'income'
  icon: string
}

interface CategoryRule {
  /** 任一关键词命中即算；按数组顺序匹配，先命中先返回 */
  keywords: string[]
  /** 目标分类名（需存在于用户分类列表） */
  category: string
  /** 限定交易类型；不填表示不限 */
  types?: Array<'expense' | 'income'>
}

/**
 * 商户/描述关键词 → 分类名。
 * 顺序敏感：具体规则必须排在笼统规则之前（如“美团”在“购物”之前）。
 */
const CATEGORY_RULES: CategoryRule[] = [
  // ---- 餐饮 ----
  { keywords: ['美团', '饿了么', '外卖', '餐', '饭店', '餐厅', '快餐', '食堂', '小吃', '美食', '火锅', '烧烤', '便当', '米线', '面馆'], category: '餐饮' },
  { keywords: ['咖啡', '瑞幸', '星巴克', '奶茶', '喜茶', '蜜雪', '茶百道'], category: '餐饮' },
  { keywords: ['肯德基', '麦当劳', '汉堡', '华莱士', '必胜客'], category: '餐饮' },
  // ---- 交通 ----
  { keywords: ['滴滴', '出租车', '网约车', '打车', '出行', '曹操出行', 'T3出行', '高德打车'], category: '交通' },
  { keywords: ['地铁', '公交', '轨道交通', '一卡通', '乘车码'], category: '交通' },
  { keywords: ['加油', '中石化', '中石油', '壳牌', '停车', '车位', 'ETC'], category: '交通' },
  { keywords: ['铁路', '12306', '高铁', '动车', '航空', '机票', '航司'], category: '交通' },
  { keywords: ['哈啰', '青桔', '美团单车', '单车', '骑行'], category: '交通' },
  // ---- 购物 ----
  { keywords: ['超市', '永辉', '沃尔玛', '家乐福', '盒马', '山姆', '大润发', '华润万家', '便利店', '全家', '罗森', '7-eleven', '美宜佳'], category: '购物' },
  { keywords: ['淘宝', '天猫', '京东', '拼多多', '唯品会', '抖音商城', '得物', '小米有品', '苏宁'], category: '购物' },
  { keywords: ['商场', '百货', '购物中心'], category: '购物' },
  // ---- 住房 ----
  { keywords: ['房租', '租金', '物业', '物业费', '水费', '电费', '水电', '燃气', '天然气', '供暖', '采暖', '房贷', '中介费'], category: '住房' },
  // ---- 娱乐 ----
  { keywords: ['电影', '影院', '猫眼', '淘票票', '万达影城'], category: '娱乐' },
  { keywords: ['游戏', 'steam', '腾讯游戏', '网易游戏', '任天堂', 'psn', '麻将'], category: '娱乐' },
  { keywords: ['会员', '视频会员', '音乐会员', '云音乐', '腾讯视频', '爱奇艺', '优酷', '芒果tv', 'netflix', '美团会员'], category: '娱乐' },
  { keywords: ['健身', '游泳', '瑜伽', '球馆', '滑雪', 'KTV', '演出', '演唱会', '门票'], category: '娱乐' },
  { keywords: ['酒店', '住宿', '民宿', '宾馆', '旅行', '旅游', '景区'], category: '娱乐' },
  // ---- 医疗 ----
  { keywords: ['医院', '药房', '药店', '诊所', '挂号', '门诊', '体检', '医疗', '口腔', '牙科', '眼科', '疫苗', '买药', '医药'], category: '医疗' },
  // ---- 教育 ----
  { keywords: ['学费', '培训', '课程', '网课', '驾校', '书店', '图书', '教育', '考试', '报名费', '幼儿园', '补习'], category: '教育' },
  // ---- 通讯 ----
  { keywords: ['话费', '流量', '宽带', '中国移动', '中国联通', '中国电信', '充值中心', '移动通信', '联通', '电信'], category: '通讯' },
  // ---- 日用 ----
  { keywords: ['日用', '洗护', '纸巾', '洗衣液', '理发', '剪发', '美容', '家政', '快递', '邮费', '顺丰', '中通', '圆通', '菜鸟'], category: '日用' },
  // ---- 服饰 ----
  { keywords: ['服饰', '衣服', '服装', '鞋', '箱包', '优衣库', 'zara', 'h&m', '耐克', 'nike', 'adidas', 'lululemon', '内衣'], category: '服饰' },
  // ---- 人情 ----
  { keywords: ['礼物', '随礼', '份子钱', '请客', '孝敬', '压岁钱'], category: '人情' },
  { keywords: ['红包'], category: '人情', types: ['expense'] },
  // ---- 收入 ----
  { keywords: ['退款', '退货', '报销'], category: '退款', types: ['income'] },
  { keywords: ['红包', '转账收款'], category: '红包', types: ['income'] },
  { keywords: ['工资', '薪资', '薪酬', '代发'], category: '工资', types: ['income'] },
  { keywords: ['奖金', '年终奖', '绩效'], category: '奖金', types: ['income'] },
  { keywords: ['利息', '收益', '分红', '基金', '理财'], category: '理财', types: ['income'] },
]

/** 兜底分类名（用户没有该分类时返回 null，不硬塞） */
const FALLBACK_CATEGORY = '其他'

/**
 * 为一条导入记录预填分类。
 * @param text 用于匹配的文本（描述 + 交易对方）
 * @param categories 当前用户的分类
 * @param type 交易类型（transfer 不参与分类，调用方自行处理）
 */
export function matchImportCategory(
  text: string,
  categories: UserCategory[],
  type: 'expense' | 'income',
): { category_id: number | null; category_name: string | null; category_icon: string | null; category_auto: boolean } {
  const empty = { category_id: null, category_name: null, category_icon: null, category_auto: false }
  const lower = text.toLowerCase()
  const pool = categories.filter((c) => c.type === type)
  for (const rule of CATEGORY_RULES) {
    if (rule.types && !rule.types.includes(type)) continue
    if (!rule.keywords.some((k) => lower.includes(k.toLowerCase()))) continue

    const hit = pool.find((c) => c.name === rule.category)
    if (hit) {
      return { category_id: hit.id, category_name: hit.name, category_icon: hit.icon, category_auto: true }
    }
  }

  // 兜底：归入「其他」（仅当用户确实有这个分类）
  const other = pool.find((c) => c.name === FALLBACK_CATEGORY)
  if (other) {
    return { category_id: other.id, category_name: other.name, category_icon: other.icon, category_auto: true }
  }

  return empty
}

/** 去重键：类型 + 金额 + 日期 + 描述 */
function dedupKey(type: string, amount: number, date: string, description: string): string {
  return `${type}|${amount}|${date}|${description.trim()}`
}

/**
 * 标记与已有记录重复的条目（同 user + type + amount + date + description，未删除）。
 *
 * 实现：一次查询取日期区间内的全部记录，在内存建 Set——
 * 逐条 SELECT 在上千行账单上会变成 N 次查询。
 *
 * @returns 重复条目的数量
 */
export function markDuplicates(
  db: Database.Database,
  userId: number,
  items: Array<{ type: string; amount: number; date: string; description: string }>,
): number {
  if (items.length === 0) return 0

  let minDate: string | null = null
  let maxDate: string | null = null
  for (const it of items) {
    if (minDate === null || it.date < minDate) minDate = it.date
    if (maxDate === null || it.date > maxDate) maxDate = it.date
  }
  if (minDate === null || maxDate === null) return 0

  const existing = db
    .prepare(
      `SELECT type, amount, date, description FROM transactions
       WHERE user_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ?`,
    )
    .all(userId, minDate, maxDate) as Array<{
    type: string
    amount: number
    date: string
    description: string | null
  }>

  const seen = new Set(
    existing.map((r) => dedupKey(r.type, r.amount, r.date, r.description || '')),
  )

  // 同一批次内部也要去重（账单里出现两笔完全相同的消费）
  const batchSeen = new Set<string>()

  let dupCount = 0
  for (const it of items) {
    const key = dedupKey(it.type, it.amount, it.date, it.description)
    const isDup = seen.has(key) || batchSeen.has(key)
    if (isDup) {
      ;(it as { duplicate?: boolean }).duplicate = true
      dupCount++
    }
    batchSeen.add(key)
  }

  return dupCount
}
