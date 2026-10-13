/**
 * 分类名→ID匹配器
 * 优先级：精确匹配 → 包含匹配 → 同义词映射 → 归入"其他"
 */

interface CategoryInfo {
  id: number
  name: string
  type: 'expense' | 'income'
}

/**
 * 同义词映射表
 *
 * ⚠️ 导出是因为它是发布期跨表判据断言的输入（ai/criterion-consistency.ts C1/C2/C3）：
 * 极性必须显式编码在条目上，不能靠「目标分类恰好在哪个桶」隐式决定。
 * 今天的「红包 → 人情」正因为极性缺失，已经和 quick-parser 的「红包 → 红包/income」
 * 在服务端互相矛盾（设计 §0.6 / §3.3 C2），Step 3 改极性桶时会被断言逮住。
 */
export const SYNONYMS: Record<string, string> = {
  // 餐饮
  吃饭: '餐饮',
  吃的: '餐饮',
  饭: '餐饮',
  外卖: '餐饮',
  午餐: '餐饮',
  晚餐: '餐饮',
  早餐: '餐饮',
  零食: '餐饮',
  奶茶: '餐饮',
  咖啡: '餐饮',
  饮料: '餐饮',
  水果: '餐饮',
  食物: '餐饮',
  美食: '餐饮',
  聚餐: '餐饮',
  // 交通
  出行: '交通',
  打车: '交通',
  公交: '交通',
  地铁: '交通',
  加油: '交通',
  停车: '交通',
  高速: '交通',
  火车: '交通',
  机票: '交通',
  骑行: '交通',
  // 购物
  买东西: '购物',
  网购: '购物',
  超市: '购物',
  商城: '购物',
  淘宝: '购物',
  京东: '购物',
  拼多多: '购物',
  // 住房
  房租: '住房',
  水电: '住房',
  物业: '住房',
  房贷: '住房',
  装修: '住房',
  // 娱乐
  游戏: '娱乐',
  电影: '娱乐',
  视频会员: '娱乐',
  音乐: '娱乐',
  旅游: '娱乐',
  门票: '娱乐',
  // 医疗
  看病: '医疗',
  药: '医疗',
  医院: '医疗',
  体检: '医疗',
  // 教育
  培训: '教育',
  课程: '教育',
  书: '教育',
  学费: '教育',
  // 通讯
  话费: '通讯',
  流量: '通讯',
  宽带: '通讯',
  手机: '通讯',
  // 日用
  日用品: '日用',
  生活用品: '日用',
  洗护: '日用',
  // 服饰
  衣服: '服饰',
  鞋: '服饰',
  包: '服饰',
  // 人情
  红包: '人情',
  礼物: '人情',
  份子钱: '人情',
  请客: '人情',
  // 收入
  薪资: '工资',
  工资: '工资',
  年终奖: '奖金',
  退货: '退款',
  报销: '退款',
}

/**
 * 匹配分类名到 category_id
 * @param aiCategoryName AI 返回的分类名
 * @param categories 用户的分类列表
 * @param type 交易类型（用于确定匹配哪种分类）
 * @returns 匹配到的分类信息，或"其他"分类；**用户该类型下一个分类都没有时返回 null**
 */
export function matchCategory(
  aiCategoryName: string,
  categories: CategoryInfo[],
  type: 'expense' | 'income',
): CategoryInfo | null {
  const filtered = categories.filter((c) => c.type === type)
  const name = aiCategoryName.trim()

  if (!name) {
    return findOther(filtered)
  }

  // 1. 精确匹配
  const exact = filtered.find((c) => c.name === name)
  if (exact) return exact

  // 2. 包含匹配（AI返回值包含分类名，或分类名包含AI返回值）
  const contains = filtered.find(
    (c) => name.includes(c.name) || c.name.includes(name),
  )
  if (contains) return contains

  // 3. 同义词映射
  const mapped = SYNONYMS[name] || SYNONYMS[name.toLowerCase()]
  if (mapped) {
    const synonym = filtered.find((c) => c.name === mapped)
    if (synonym) return synonym
  }

  // 3.1 遍历同义词表检查是否 AI 返回值包含某个同义词
  for (const [keyword, target] of Object.entries(SYNONYMS)) {
    if (name.includes(keyword)) {
      const match = filtered.find((c) => c.name === target)
      if (match) return match
    }
  }

  // 4. 归入"其他"
  return findOther(filtered)
}

/**
 * 该匹配是不是「精确命中」。
 *
 * 判据：匹配到的分类名与模型给出的分类名**逐字相同**，且不是兜底的「其他」。
 * 供出参扩展（契约 §6）派生 `needs_review` / `confidence` 用——
 * 模糊匹配（包含/同义词）或回落「其他」都算**非精确**。
 */
export function isExactCategoryMatch(
  aiCategoryName: string,
  matchedName: string | null | undefined,
): boolean {
  if (!matchedName) return false
  if (matchedName === '其他') return false
  return aiCategoryName.trim() === matchedName
}

/**
 * 兜底分类：优先「其他」，否则第一个该类型的分类。
 *
 * ⚠️ 一个都没有时返回 **null**，绝不返回 `{ id: 0 }`：
 * 0 是**不存在的 id**，客户端拿它去 `POST /transactions` 会被归属校验
 * 400 拒掉（“分类 ID 0 不存在”），用户点确认却存不进去；
 * 而 `null` 是契约内合法值（转账路径本来就是 null，所以前端早已处理）。
 */
function findOther(categories: CategoryInfo[]): CategoryInfo | null {
  const other = categories.find((c) => c.name === '其他')
  if (other) return other
  // 兜底：返回第一个分类
  return categories[0] ?? null
}
