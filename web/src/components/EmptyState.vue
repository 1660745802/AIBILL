<script setup lang="ts">
withDefaults(defineProps<{
  icon?: string
  title?: string
  description?: string
}>(), {
  icon: '💭',
  title: '暂无数据',
})
</script>

<template>
  <div class="flex flex-col items-center justify-center py-12 px-4">
    <span class="text-4xl mb-3">{{ icon }}</span>
    <p class="text-sm font-medium text-gray-500">{{ title }}</p>
    <p v-if="description" class="mt-1 text-xs text-gray-400">{{ description }}</p>
  </div>
</template>
