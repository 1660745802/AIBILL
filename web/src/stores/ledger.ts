import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

/**
 * 账本的浏览状态：筛选条件 + 每份列表的滚动位置。
 *
 * 为什么单独放 store：这些状态属于「你上次在哪儿看到哪儿」，
 * 而不是属于账本这个组件。组件被路由销毁又重建（这是 Vue Router 的常态），
 * 只有存在外面才留得住。
 *
 * 落 sessionStorage 而不是内存：
 * 记账的人经常是「记账 → 去看某个月 → 回来」，中途可能顺手刷新一下，
 * 内存态一刷新就没了，等于没做。
 */
export const LEDGER_STATE_KEY = 'bill.ledger-state'

interface Saved {
  keyword: string
  filterType: string
  activeTab: 'transactions' | 'stats'
}

function load(): Saved {
  try {
    const raw = sessionStorage.getItem(LEDGER_STATE_KEY)
    if (raw) {
      const v = JSON.parse(raw)
      return {
        keyword: typeof v.keyword === 'string' ? v.keyword : '',
        filterType: typeof v.filterType === 'string' ? v.filterType : '',
        activeTab: v.activeTab === 'stats' ? 'stats' : 'transactions',
      }
    }
  } catch { /* 坏数据直接当没有 */ }
  return { keyword: '', filterType: '', activeTab: 'transactions' }
}

export const useLedgerStore = defineStore('ledger', () => {
  const saved = load()

  const keyword = ref(saved.keyword)
  const filterType = ref(saved.filterType)
  const activeTab = ref<'transactions' | 'stats'>(saved.activeTab)

  watch([keyword, filterType, activeTab], () => {
    sessionStorage.setItem(LEDGER_STATE_KEY, JSON.stringify({
      keyword: keyword.value,
      filterType: filterType.value,
      activeTab: activeTab.value,
    }))
  })

  /**
   * 滚动位置记忆：key = 月份 + 当前筛选。
   * 换筛选条件后旧位置没有意义（「支出」第 5 条 ≠ 「收入」第 5 条），
   * 所以必须带进 key 里，否则回来会落在一个莫名其妙的位置。
   */
  const scrollMemory = new Map<string, number>()

  function scrollKey(period: string, tab: string, type: string, kw: string): string {
    return `${period}|${tab}|${type}|${kw}`
  }
  function remember(key: string, top: number) {
    scrollMemory.set(key, top)
  }
  function recall(key: string): number {
    return scrollMemory.get(key) ?? 0
  }
  function forget(key: string) {
    scrollMemory.delete(key)
  }

  function reset() {
    keyword.value = ''
    filterType.value = ''
    activeTab.value = 'transactions'
    scrollMemory.clear()
  }

  return {
    keyword, filterType, activeTab,
    scrollKey, remember, recall, forget, reset,
  }
})
