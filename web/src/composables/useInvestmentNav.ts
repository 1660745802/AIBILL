import { ref } from 'vue'
import api from '@/api'

/**
 * 「导航里要不要显示投资」的共享状态。
 *
 * 为什么不做成 App.vue 的局部 ref：账户类型在**别的页面**被改
 * （资产页的账户设置、投资页），改完侧栏必须立刻跟上。
 * 局部 ref 只能等下一次整页刷新 —— 用户改完账户类型找不到「投资」，
 * 就变成「功能存在但入口不出现」那类问题。
 *
 * 模块级单例（和 useQuickEntry 同样的理由）：在函数体内 new 一个 ref，
 * 每次调用都是一个独立实例，写入方和读取方根本不是同一份状态。
 */
const hasInvestment = ref(false)
let loaded = false

export async function refreshInvestmentNav(force = false): Promise<void> {
  if (loaded && !force) return
  try {
    const { data } = await api.get('/accounts')
    if (data.code === 0) {
      hasInvestment.value = (data.data.items ?? []).some(
        (a: { asset_type?: string }) => a.asset_type === 'investment',
      )
      loaded = true
    }
  } catch {
    // 读不到就保持上一次的结果：网络抖一下不该让入口消失
  }
}

export function useInvestmentNav() {
  return { hasInvestment, refreshInvestmentNav }
}
