<script setup lang="ts">
withDefaults(defineProps<{
  lines?: number
  avatar?: boolean
}>(), {
  lines: 3,
  avatar: false,
})

// Pre-generate random widths so they don't change on re-render
const widths = Array.from({ length: 10 }, () => Math.floor(Math.random() * 41) + 60)
</script>

<template>
  <div class="animate-pulse space-y-3 p-4">
    <div v-if="avatar" class="flex items-center gap-3 mb-4">
      <div class="w-10 h-10 bg-gray-200 rounded-full shrink-0"></div>
      <div class="flex-1 space-y-2">
        <div class="h-3 bg-gray-200 rounded" style="width: 40%"></div>
        <div class="h-3 bg-gray-200 rounded" style="width: 60%"></div>
      </div>
    </div>
    <div
      v-for="i in lines"
      :key="i"
      class="h-3 bg-gray-200 rounded"
      :style="{ width: `${widths[i % widths.length]}%` }"
    ></div>
  </div>
</template>
