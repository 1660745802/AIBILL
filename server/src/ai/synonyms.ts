/**
 * 同义词表：**极性桶**（Step 3；数据不是判定逻辑，故独立成文件）
 *
 * 为什么独立成文件：这张表在重写前住在 category-matcher.ts 里，阶梯重写后那个文件
 * 超了 ARCHITECTURE §4.2 的 300 行上限。
 *
 * ## 为什么是「桶」而不是 Record<string, string>
 *
 * Step 1/2 的形状是 `Record<key, 目标>` + 一个「哪些目标属于收入桶」的推断表，
 * 于是**一个 key 只能有一个目标**——而「红包」有两个资金方向，两条都正确：
 *   · 发出红包 = 送礼的人情往来 → 支出分类「人情」
 *   · 收到红包 = 真实收入       → 收入分类「红包」（种子分类里真的有这个分类）
 * 表达不了双方向，就只能二选一，结果是判据 C8 抓出来的那条冲突：
 * `('红包','income')`：SYNONYMS 说「人情」，import-matcher 说「红包」。
 *
 * 现在 `type` 是**每条必填、无默认**的字段，同一个 key 可以有多条、按 type 区分。
 * 匹配时先过极性闸（expense 请求永远看不到 income 桶的词条，反之亦然），
 * 所以两条永不同时生效；用户删掉收入「红包」分类时，income 词条因目标不存在
 * 被**丢弃候选**（绝不改投到 expense 的「人情」）。
 *
 * 这张表也是判据断言的输入：C1（每条必须显式带 type）、C3（目标必须存在于
 * 同极性的种子分类表）、C8（与 import-matcher 的交叉一致性）。
 */

import type { CategoryType } from './category-matcher.js'

/**
 * 极性桶条目。`type` 是**必填字段、无默认值**：漏写就是漏写，判据 C1 会报出来，
 * 不会像以前那样静默回退到「目标分类恰好在哪一桶」的隐式推断。
 * 同一个 key 允许有多条、按 type 区分（见下方「红包」）。
 */
export interface SynonymEntry {
  readonly key: string
  readonly category: string
  readonly type: CategoryType
}

export const SYNONYMS: readonly SynonymEntry[] = [
  // ── 餐饮（支出）──
  { key: '吃饭', category: '餐饮', type: 'expense' },
  { key: '吃的', category: '餐饮', type: 'expense' },
  { key: '饭', category: '餐饮', type: 'expense' },
  { key: '外卖', category: '餐饮', type: 'expense' },
  { key: '午餐', category: '餐饮', type: 'expense' },
  { key: '晚餐', category: '餐饮', type: 'expense' },
  { key: '早餐', category: '餐饮', type: 'expense' },
  { key: '零食', category: '餐饮', type: 'expense' },
  { key: '奶茶', category: '餐饮', type: 'expense' },
  { key: '咖啡', category: '餐饮', type: 'expense' },
  { key: '饮料', category: '餐饮', type: 'expense' },
  { key: '水果', category: '餐饮', type: 'expense' },
  { key: '食物', category: '餐饮', type: 'expense' },
  { key: '美食', category: '餐饮', type: 'expense' },
  { key: '聚餐', category: '餐饮', type: 'expense' },
  // ── 交通（支出）──
  { key: '出行', category: '交通', type: 'expense' },
  { key: '打车', category: '交通', type: 'expense' },
  { key: '公交', category: '交通', type: 'expense' },
  { key: '地铁', category: '交通', type: 'expense' },
  { key: '加油', category: '交通', type: 'expense' },
  { key: '停车', category: '交通', type: 'expense' },
  { key: '高速', category: '交通', type: 'expense' },
  { key: '火车', category: '交通', type: 'expense' },
  { key: '机票', category: '交通', type: 'expense' },
  { key: '骑行', category: '交通', type: 'expense' },
  // ── 购物（支出）──
  { key: '买东西', category: '购物', type: 'expense' },
  { key: '网购', category: '购物', type: 'expense' },
  { key: '超市', category: '购物', type: 'expense' },
  { key: '商城', category: '购物', type: 'expense' },
  { key: '淘宝', category: '购物', type: 'expense' },
  { key: '京东', category: '购物', type: 'expense' },
  { key: '拼多多', category: '购物', type: 'expense' },
  // ── 住房（支出）──
  { key: '房租', category: '住房', type: 'expense' },
  { key: '水电', category: '住房', type: 'expense' },
  { key: '物业', category: '住房', type: 'expense' },
  { key: '房贷', category: '住房', type: 'expense' },
  { key: '装修', category: '住房', type: 'expense' },
  // ── 娱乐（支出）──
  { key: '游戏', category: '娱乐', type: 'expense' },
  { key: '电影', category: '娱乐', type: 'expense' },
  { key: '视频会员', category: '娱乐', type: 'expense' },
  { key: '音乐', category: '娱乐', type: 'expense' },
  { key: '旅游', category: '娱乐', type: 'expense' },
  { key: '门票', category: '娱乐', type: 'expense' },
  // ── 医疗（支出）──
  { key: '看病', category: '医疗', type: 'expense' },
  { key: '药', category: '医疗', type: 'expense' },
  { key: '医院', category: '医疗', type: 'expense' },
  { key: '体检', category: '医疗', type: 'expense' },
  // ── 教育（支出）──
  { key: '培训', category: '教育', type: 'expense' },
  { key: '课程', category: '教育', type: 'expense' },
  { key: '书', category: '教育', type: 'expense' },
  { key: '学费', category: '教育', type: 'expense' },
  // ── 通讯（支出）──
  { key: '话费', category: '通讯', type: 'expense' },
  { key: '流量', category: '通讯', type: 'expense' },
  { key: '宽带', category: '通讯', type: 'expense' },
  { key: '手机', category: '通讯', type: 'expense' },
  // ── 日用（支出）──
  { key: '日用品', category: '日用', type: 'expense' },
  { key: '生活用品', category: '日用', type: 'expense' },
  { key: '洗护', category: '日用', type: 'expense' },
  // ── 服饰（支出）──
  { key: '衣服', category: '服饰', type: 'expense' },
  { key: '鞋', category: '服饰', type: 'expense' },
  { key: '包', category: '服饰', type: 'expense' },
  // ── 人情（支出）──
  // ⚠️ 「红包」是**同 key 双极性**的唯一一个词，务必读下一行：
  { key: '红包', category: '人情', type: 'expense' },   // 发出红包 = 送礼的人情往来
  { key: '礼物', category: '人情', type: 'expense' },
  { key: '份子钱', category: '人情', type: 'expense' },
  { key: '请客', category: '人情', type: 'expense' },
  { key: '红包', category: '红包', type: 'income' },    // 收到红包 = 收入分类「红包」
  // ── 收入 ──
  { key: '薪资', category: '工资', type: 'income' },
  { key: '工资', category: '工资', type: 'income' },
  { key: '年终奖', category: '奖金', type: 'income' },
  { key: '退货', category: '退款', type: 'income' },
  { key: '报销', category: '退款', type: 'income' },
]