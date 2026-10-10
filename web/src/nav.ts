/**
 * 导航结构（单一真源）
 *
 * 按**功能**分组，不按使用频率。上一版用「每天 / 偶尔」分层，但那条轴有个
 * 前提：所有页面都是同一种东西的不同频次。加入投资后不成立了——
 * 「账户总览」「投资组合」是**状态**，「记一笔」是**动作**，
 * 状态和动作不在同一条频率轴上。
 *
 * 分三组：**账目**（我记了什么）/ **资产**（我有多少钱）/ **系统**（数据进出与配置）。
 * 曾经分过五组（账本/资产/洞察/工具/系统），但每组平均只有 2 项——
 * 侧栏里组头和条目一样多，一半是标题，反而更难扫。
 *
 * 侧栏（桌面）、底栏（手机）、「我的」索引页都从这里派生，避免三处各写一份
 * 互相漂移——上一版就因为侧栏和「我的」各列一遍，产生过重复入口。
 *
 * 记一笔**不再单独突出**：网页承担的是**数据整合**，不是记账主入口
 * （记账主要走 Android 的通知自动记账）。所以它从「侧栏顶按钮 + 右下 FAB」
 * 降级成一个普通导航项，和账本并列。⌘K / N 快捷键保留——它们不占视觉权重，
 * 只是让偶尔要手记一笔的人少点一下。
 */

export interface NavItem {
  path: string
  label: string
  icon: string
  /** 「我的」索引页用的一句话说明 */
  desc?: string
  /** 仅管理员可见 */
  adminOnly?: boolean
  /** 占用手机底栏的一个槽位（底栏是 4 个物理槽，塞不进「组」，只能放页面） */
  mobileSlot?: boolean
  /**
   * 仅当存在 `asset_type='investment'` 的账户时才出现。
   * 没有理财账户时「投资」页无事可做，摆在导航里只增加选择成本。
   */
  needsInvestment?: boolean
}

export interface NavGroup {
  key: string
  label: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    key: 'ledger',
    label: '账目',
    /*
     * 关于「我记了什么」：流水、汇总、录入、以及对着账本问 AI。
     * 原来这块被拆成「账本 / 洞察」两组（每组 2 项），分组头本身占的行数
     * 和内容差不多——5 个组头 11 个条目，侧栏一半是标题。
     * 现在按语义合回一组：看账、记一笔、看汇总、问 AI，都是同一件事的不同动作。
     */
    items: [
      { path: '/ledger', label: '账本', icon: 'ledger', desc: '流水、统计与搜索', mobileSlot: true },
      { path: '/', label: '记一笔', icon: 'pen', desc: '手动记一笔（主要靠 App 自动记账）', mobileSlot: true },
      { path: '/overview', label: '本月结算', icon: 'gauge', desc: '这个月发生了什么', mobileSlot: true },
      { path: '/ai', label: 'AI 助手', icon: 'spark', desc: '基于你的账本回答问题' },
    ],
  },
  {
    key: 'assets',
    label: '资产',
    /*
     * 关于「我有多少钱」。
     * 汇总/明细两层：资产 = 每个账户一个数（汇总）；投资 = 持仓明细。
     * 「投资」只在有理财账户时出现（needsInvestment），没有理财账户时它无事可做，
     * 摆在导航里只增加选择成本。
     */
    items: [
      { path: '/assets', label: '账户总览', icon: 'wallet', desc: '各账户余额与净资产', mobileSlot: true },
      { path: '/investments', label: '投资', icon: 'trendUp', desc: '持仓明细与盈亏', needsInvestment: true },
    ],
  },
  {
    key: 'system',
    label: '系统',
    /* 数据进出 + 配置。都是低频入口，合成一组，不各占一个组头。 */
    items: [
      { path: '/import', label: '导入账单', icon: 'upload', desc: '微信 / 支付宝 CSV' },
      { path: '/trash', label: '回收站', icon: 'trash', desc: '已删除的记录' },
      { path: '/settings', label: '设置', icon: 'settings', desc: '账户与偏好' },
      { path: '/admin', label: '管理面板', icon: 'shield', desc: '用户与系统', adminOnly: true },
    ],
  },
]

/** 手机底栏：按 mobileSlot 标记取，顺序即底栏顺序 */
export function mobileTabs(): NavItem[] {
  return NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.mobileSlot)
}

/** 全部可达路径（含仅管理员项），用于判断某页是否属于导航 */
export function allNavPaths(): string[] {
  return NAV_GROUPS.flatMap((g) => g.items).map((i) => i.path)
}
