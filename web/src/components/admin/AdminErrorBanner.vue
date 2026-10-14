<script setup lang="ts">
/**
 * 读失败时的统一提示。
 *
 * 原先这一段内联在 `Admin.vue` 顶部，靠 `tabHasError(activeTab)` 判断——等于替**当前 tab**
 * 显示一条全局 banner。拆成 panel 后，「哪个请求失败」是 panel 内部知识，错误态就随 panel 走；
 * 本组件只负责把「读不到 ≠ 没有数据」这条文案统一，避免 9 个 panel 各写一遍。
 */
import Notice from '@/components/ui/Notice.vue'

defineProps<{ show: boolean }>()
const emit = defineEmits<{ retry: [] }>()
</script>

<template>
  <Notice v-if="show" tone="warn" class="mb-4">
    <div class="flex items-center justify-between gap-3">
      <span class="text-xs">读不到数据（接口失败或超时）—— 这不是「没有数据」。</span>
      <button type="button" class="act shrink-0" @click="emit('retry')">重试</button>
    </div>
  </Notice>
</template>
