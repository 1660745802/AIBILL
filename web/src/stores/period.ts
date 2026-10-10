import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

/**
 * 全局周期：跨页面共享的「正在看哪个月」。
 *
 * 为什么必须全局：以前周期只活在账本页，从「账本 3 月」切到「本月」
 * 会突然跳回当月——这是整个产品最容易让人记错账的地方。现在周期是
 * 仪表读数的一部分（右上角控件），所有页面跟着它走，刷新后还记得。
 */
export const PERIOD_KEY = 'bill.period'
const now = new Date()
const ym = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`

function initial(): string {
  const saved = localStorage.getItem(PERIOD_KEY)
  return saved && /^\d{4}-\d{2}$/.test(saved) ? saved : ym(now)
}

export const usePeriodStore = defineStore('period', () => {
  const current = ref(initial())

  const year = computed(() => Number(current.value.slice(0, 4)))
  const month = computed(() => Number(current.value.slice(5, 7)))
  const label = computed(() => `${year.value} 年 ${month.value} 月`)
  const shortLabel = computed(() => `${month.value} 月`)
  const isCurrent = computed(() => current.value === ym(now))

  /** 该月天数：刻度带量程算「按日均外推」时要它 */
  const daysInMonth = computed(() => new Date(year.value, month.value, 0).getDate())
  const daysElapsed = computed(() =>
    isCurrent.value ? now.getDate() : daysInMonth.value,
  )

  function set(v: string) {
    if (!/^\d{4}-\d{2}$/.test(v)) return
    current.value = v
    localStorage.setItem(PERIOD_KEY, v)
  }
  function shift(delta: number) {
    const d = new Date(year.value, month.value - 1 + delta, 1)
    set(ym(d))
  }
  function toCurrent() { set(ym(now)) }

  /** 「2026-09」→ 该月首末日，接口入参直接用 */
  const range = computed(() => {
    const mm = String(month.value).padStart(2, '0')
    return {
      start_date: `${year.value}-${mm}-01`,
      end_date: `${year.value}-${mm}-${String(daysInMonth.value).padStart(2, '0')}`,
    }
  })

  return {
    current, year, month, label, shortLabel, isCurrent,
    daysInMonth, daysElapsed, range,
    set, shift, toCurrent,
  }
})
