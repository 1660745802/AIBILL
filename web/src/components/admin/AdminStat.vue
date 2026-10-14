<script setup lang="ts">
/**
 * 管理面板的指标格。
 *
 * 原先同一段 markup（`admin-stat` + 顶部语义色条 + 等宽大数字 + 小标签）
 * 在 4 个 panel 里被抄了 28 次。收成一个 module：
 * `value` + 默认插槽（label）+ `tone`（顶部 2px 语义色条，取 `--color-<tone>`）。
 */
withDefaults(defineProps<{ value: string | number; tone: string; labelClass?: string }>(), {
  labelClass: '',
})
</script>

<template>
  <div class="admin-stat" :style="`border-top-color: var(--color-${tone})`">
    <div class="admin-stat-num">{{ value }}</div>
    <div class="admin-stat-label" :class="labelClass"><slot /></div>
  </div>
</template>
