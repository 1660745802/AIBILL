<script setup lang="ts">
/**
 * 刻度带 gauge：仪表读数的身份件。
 *
 * 规则：**没有有意义量程的数字不给刻度带。**
 * 指针的位置必须能被解释成「这个数在同类里处于什么位置」，
 * 否则就是装饰。所以 max / 红区起点 / 目标线都由调用方给定，
 * 两端都写上量程标签，不让人猜指针指在哪。
 */
const props = withDefaults(defineProps<{
  /** 指针位置，0–100（超量程会截断） */
  pos: number
  /** 指针语气：正常 / 警戒 / 红区 / 达标 */
  tone?: 'neutral' | 'amber' | 'redline' | 'ok'
  /** 红区起点（%），默认没有红区 */
  redStart?: number | null
  /** 目标刻度位置（%），虚线 + 标签 */
  target?: number | null
  targetLabel?: string
  /** 量程两端标签，调用者自己给 */
  minLabel?: string
  maxLabel?: string
  /** 首次落针动画 */
  settle?: boolean
}>(), {
  tone: 'neutral',
  redStart: null,
  target: null,
  targetLabel: '',
  minLabel: '',
  maxLabel: '',
  settle: false,
})

const clamp = (v: number) => Math.max(0, Math.min(100, v))
const needleClass = {
  neutral: '',
  amber: 'gauge-needle-amber',
  redline: 'gauge-needle-redline',
  ok: 'gauge-needle-ok',
}[props.tone]
</script>

<template>
  <div class="gauge">
    <!-- 红区画在刻度面之上（同一层的背景位） -->
    <div
      v-if="redStart != null && redStart < 100"
      class="gauge-redline"
      :style="{ '--gauge-red-start': redStart }"
    />
    <div
      v-if="target != null"
      class="gauge-target"
      :style="{ '--gauge-target': target }"
    />
    <div
      class="gauge-needle"
      :class="[needleClass, settle && 'gauge-needle-settle']"
      :style="{ '--gauge-pos': clamp(pos) }"
    />
    <span
      v-if="target != null && targetLabel"
      class="gauge-target-label"
      :style="{ '--gauge-target': target }"
    >{{ targetLabel }}</span>
  </div>
  <div v-if="minLabel || maxLabel" class="gauge-scale">
    <span>{{ minLabel }}</span>
    <span>{{ maxLabel }}</span>
  </div>
</template>
