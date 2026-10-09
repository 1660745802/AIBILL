<script setup lang="ts">
/**
 * 金额渲染：整数重、小数轻，千分位对齐。
 * 入参一律「分」（见 utils/money.ts）。
 */
import { computed } from 'vue'
import { centsToYuan } from '@/utils/money'

const props = withDefaults(defineProps<{
  value: number
  size?: 'sm' | 'md' | 'lg' | 'hero'
  tone?: 'expense' | 'income' | 'neutral' | 'muted' | 'info'
  /**
   * auto（默认）：符号由语义色决定——支出带 −，收入带 +，其余按数值正负。
   * none：恒不带符号（如「已花 / 预算」这类本身为正的量）。
   * plus / minus：强制。
   */
  sign?: 'auto' | 'plus' | 'minus' | 'none'
  /** 数字部分是否取绝对值（默认 true；符号由 sign 单独承担，不会出现 --） */
  absolute?: boolean
}>(), {
  size: 'md',
  tone: 'neutral',
  sign: 'auto',
  absolute: true,
})

const parts = computed(() => {
  const yuan = centsToYuan(props.value)
  const magnitude = props.absolute ? Math.abs(yuan) : yuan
  const [int, frac] = magnitude.toFixed(2).split('.')

  let prefix = ''
  if (props.sign === 'plus') prefix = '+'
  else if (props.sign === 'minus') prefix = '−'
  else if (props.sign === 'auto') {
    // 账目方向由语义色决定：支出永远是减，收入永远是加
    if (props.tone === 'expense') prefix = '−'
    else if (props.tone === 'income') prefix = '+'
    else if (yuan < 0) prefix = '−'
  }

  return { prefix, int: Number(int).toLocaleString('zh-CN'), frac }
})

const sizeClass = computed(() => ({
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-lg',
  hero: 'text-[2.125rem] sm:text-[2.5rem]',
}[props.size]))

const toneClass = computed(() => ({
  expense: 'amt-expense',
  income: 'amt-income',
  neutral: 'amt-neutral',
  muted: 'amt-muted',
  info: 'text-info',
}[props.tone]))
</script>

<template>
  <span
    class="money inline-flex items-baseline amt"
    :class="[sizeClass, toneClass, size === 'hero' ? 'amt-hero' : '']"
  >
    <span v-if="parts.prefix" class="money-sign">{{ parts.prefix }}</span><span
      class="money-sym"
      :class="size === 'hero' ? 'text-[0.6em] opacity-60 mr-[0.12em]' : 'opacity-70 mr-[0.1em]'"
    >¥</span><span class="money-int">{{ parts.int }}</span><span
      class="money-frac"
      :class="size === 'hero' ? 'text-[0.55em] opacity-55' : 'text-[0.82em] opacity-70'"
    >.{{ parts.frac }}</span>
  </span>
</template>

<style scoped>
.money { white-space: nowrap; }
.money-sign { margin-right: 0.08em; }
</style>
