<script setup lang="ts">

/**
 * 计量条。
 * >100% 时填充截断到 100% 并叠加斜纹，明确表示"已经越线"。
 */
withDefaults(defineProps<{
  percent: number
  tone?: 'ink' | 'warn' | 'danger' | 'income'
  height?: 'xs' | 'sm'
  over?: boolean
}>(), { tone: 'ink', height: 'xs', over: false })

const TONE: Record<string, string> = {
  ink: 'var(--color-action)',
  warn: 'var(--color-warn)',
  danger: 'var(--color-expense)',
  income: 'var(--color-income)',
}
</script>

<template>
  <div
    class="meter"
    :class="height === 'sm' ? '!h-[7px]' : ''"
    role="progressbar"
    :aria-valuenow="Math.round(percent)"
    aria-valuemin="0"
    aria-valuemax="100"
  >
    <div
      class="meter-fill"
      :class="over ? 'meter-over' : ''"
      :style="{
        width: Math.min(100, Math.max(0, percent)) + '%',
        background: TONE[tone],
      }"
    />
  </div>
</template>

<style scoped>
.meter-over {
  background-image: repeating-linear-gradient(
    -45deg,
    rgb(255 255 255 / 0.55) 0 2px,
    transparent 2px 5px
  );
}
</style>
