<script setup lang="ts">
/**
 * 管理面板固定底部的分页页脚（`共 N 条` + 上/下页）。
 *
 * 原先这段 markup 在 quality / logs / release 三个 panel 各抄一份，且「中间是
 * `page / totalPages` 还是只有 `page`」不一致。收成一个 module：
 * `showTotalPages=false` 时中间只显示当前页、下一页不禁用（logs 的旧行为，
 * 它拿不到总页数）；其余显示 `page / totalPages`。
 *
 * 显隐（`v-if="total > pageSize"` 之类）由调用方决定，组件只负责渲染与 emit。
 */
import AppIcon from '@/components/ui/AppIcon.vue'

const props = withDefaults(
  defineProps<{ page: number; total: number; totalPages: number; showTotalPages?: boolean }>(),
  { showTotalPages: true },
)
const emit = defineEmits<{ change: [page: number] }>()
</script>

<template>
  <div class="flex items-center justify-between mt-4 pt-3 border-t border-rule">
    <span class="text-xs text-ink-3 amt">共 {{ props.total }} 条</span>
    <div class="flex items-center gap-1">
      <button
        type="button"
        class="btn btn-outline btn-sm btn-icon"
        :disabled="props.page <= 1"
        @click="emit('change', props.page - 1)"
      ><AppIcon name="chevronLeft" :size="14" /></button>
      <span class="px-2 text-xs text-ink-2 amt">
        <template v-if="props.showTotalPages">{{ props.page }} / {{ props.totalPages }}</template>
        <template v-else>{{ props.page }}</template>
      </span>
      <button
        type="button"
        class="btn btn-outline btn-sm btn-icon"
        :disabled="props.showTotalPages && props.page >= props.totalPages"
        @click="emit('change', props.page + 1)"
      ><AppIcon name="chevronRight" :size="14" /></button>
    </div>
  </div>
</template>
