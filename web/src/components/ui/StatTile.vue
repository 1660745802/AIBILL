<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from './AppIcon.vue'

/**
 * 指标格。纵向：label 在上 / value 在下。
 * delta 语义：deltaInvert=true 用于"支出/负债"这类指标——涨是坏事，显示为红。
 */
const props = withDefaults(defineProps<{
  label: string
  hint?: string
  /** 环比百分比，null 表示无数据 */
  delta?: number | null
  /** true = 指标越高越糟（支出、负债） */
  deltaInvert?: boolean
  /** 顶边语义色条 */
  accent?: string
  compact?: boolean
}>(), { hint: '', delta: null, deltaInvert: false, accent: '', compact: false })

const deltaClass = computed(() => {
  if (props.delta === null) return ''
  const worse = props.deltaInvert ? props.delta > 0 : props.delta < 0
  return worse ? 'delta-up' : 'delta-down'
})
const deltaIcon = computed(() =>
  (props.delta ?? 0) > 0 ? 'trendUp' : 'trendDown',
)
</script>

<template>
  <div
    class="stat-tile"
    :class="compact ? 'stat-compact' : ''"
    :style="accent ? { borderTopColor: accent } : ''"
  >
    <div class="stat-label">{{ label }}</div>

    <div class="stat-body"><slot /></div>

    <div v-if="hint || delta !== null" class="stat-foot">
      <span v-if="delta !== null" class="stat-delta" :class="deltaClass">
        <AppIcon :name="deltaIcon" :size="11" :stroke="2.4" />
        {{ Math.abs(delta).toFixed(1) }}%
      </span>
      <span v-if="hint" class="stat-hint">{{ hint }}</span>
    </div>
  </div>
</template>

<style scoped>
.stat-tile {
  background: var(--color-paper-raised);
  border: 1px solid var(--color-rule);
  border-top: 2px solid var(--color-rule);
  border-radius: var(--radius-sm);
  padding: 0.6875rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.3125rem;
  min-width: 0;
}
.stat-compact { padding: 0.5rem 0.625rem; gap: 0.25rem; }
.stat-label {
  font-size: 0.6875rem;
  font-weight: 600;
  color: var(--color-ink-3);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.stat-body { min-width: 0; }
.stat-foot {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  line-height: 1.2;
  min-height: 0.875rem;
}
.stat-delta {
  display: inline-flex;
  align-items: center;
  gap: 0.125rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.stat-hint {
  color: var(--color-ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
</style>
