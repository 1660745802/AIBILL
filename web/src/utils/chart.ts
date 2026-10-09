/**
 * 图表配色。
 *
 * canvas 的 fillStyle/strokeColor 不认 CSS 自定义属性，也不认 `var()`，
 * 必须先用 getComputedStyle 取到计算值再交给 chart.js。
 * 顺手处理深色模式切换：schemeTick 在配色方案变化时自增，
 * 依赖它的 computed 会重算，图表随之重绘。
 */
import { ref, onMounted, onUnmounted } from 'vue'

/** 取 CSS 变量的计算值 */
export function cssVar(name: string, fallback = '#000'): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** 配色方案变化时自增的计数器（放进 computed 里建立依赖） */
const schemeTick = ref(0)
let bound = false

export function useChartColors() {
  onMounted(() => {
    if (bound) return
    bound = true
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', () => { schemeTick.value++ })
  })
  onUnmounted(() => { bound = false })
  return { schemeTick }
}

/** 语义色读取器（带兜底值，避免 SSR / 未注入主题时拿到空串） */
export const ink = {
  get strong() { return cssVar('--color-action', '#39434b') },
  get mid() { return cssVar('--color-ink-3', '#7b838b') },
  get faint() { return cssVar('--color-ink-4', '#a6adb4') },
  get line() { return cssVar('--color-rule', '#dce0e4') },
  get surface() { return cssVar('--color-paper-raised', '#fff') },
}
export const tone = {
  get expense() { return cssVar('--color-expense', '#c0392f') },
  get income() { return cssVar('--color-income', '#1f7a54') },
  get warn() { return cssVar('--color-warn', '#a86312') },
  get info() { return cssVar('--color-info', '#2a5d8c') },
}

/** 多序列分类配色：围绕语义色循环，不引入彩虹色 */
export const CATEGORY_PALETTE = () => [
  ink.strong, tone.expense, tone.income, tone.info, tone.warn,
  ink.mid, tone.info, tone.expense, tone.income, ink.faint,
]

/** 所有图表共用的基础配置 */
export function baseScales() {
  return {
    y: {
      beginAtZero: true,
      grid: { color: cssVar('--color-rule-faint', '#eaecee') },
      ticks: { font: { size: 10 }, color: ink.mid, maxTicksLimit: 5 },
    },
    x: {
      grid: { display: false },
      border: { color: ink.line },
      ticks: { font: { size: 10 }, color: ink.mid, maxRotation: 0, maxTicksLimit: 8 },
    },
  }
}
