<script setup lang="ts">
withDefaults(defineProps<{
  /** lines = 文本行；block = 大块（图表/卡片） */
  variant?: 'lines' | 'block' | 'rows'
  lines?: number
  height?: string
}>(), { variant: 'lines', lines: 3, height: '' })
</script>

<template>
  <div class="space-y-2.5" aria-busy="true" aria-live="polite">
    <template v-if="variant === 'block'">
      <div class="skeleton" :style="{ height: height || '8rem' }" />
    </template>

    <template v-else-if="variant === 'rows'">
      <div v-for="i in lines" :key="i" class="flex items-center gap-3 py-2.5">
        <div class="skeleton w-7 h-7 rounded" />
        <div class="flex-1 space-y-1.5">
          <div class="skeleton h-3" :style="{ width: 40 + ((i * 17) % 45) + '%' }" />
          <div class="skeleton h-2.5 w-1/3" />
        </div>
        <div class="skeleton h-3.5 w-16" />
      </div>
    </template>

    <template v-else>
      <div
        v-for="i in lines"
        :key="i"
        class="skeleton h-3"
        :style="{ width: 55 + ((i * 23) % 40) + '%' }"
      />
    </template>
  </div>
</template>
