<script setup lang="ts">
defineProps<{
  show: boolean
  title?: string
  message: string
  confirmText?: string
  cancelText?: string
  danger?: boolean
}>()

const emit = defineEmits<{
  confirm: []
  cancel: []
}>()
</script>

<template>
  <Teleport to="body">
    <Transition
      enter-active-class="transition-opacity duration-200"
      leave-active-class="transition-opacity duration-150"
      enter-from-class="opacity-0"
      leave-to-class="opacity-0"
    >
      <div v-if="show" class="fixed inset-0 z-[9998] flex items-center justify-center p-4">
        <!-- 遮罩 -->
        <div class="absolute inset-0 bg-black/40" @click="emit('cancel')"></div>

        <!-- 弹窗内容 -->
        <Transition
          enter-active-class="transition-all duration-200 ease-out"
          leave-active-class="transition-all duration-150 ease-in"
          enter-from-class="opacity-0 scale-95"
          leave-to-class="opacity-0 scale-95"
        >
          <div v-if="show" class="relative bg-white rounded-xl shadow-xl w-full max-w-sm p-5">
            <h3 v-if="title" class="text-base font-semibold text-gray-900 mb-2">{{ title }}</h3>
            <p class="text-sm text-gray-600 leading-relaxed">{{ message }}</p>

            <div class="flex gap-3 mt-5">
              <button
                @click="emit('cancel')"
                class="flex-1 py-2 text-sm font-medium text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
              >
                {{ cancelText || '取消' }}
              </button>
              <button
                @click="emit('confirm')"
                class="flex-1 py-2 text-sm font-medium text-white rounded-lg transition-colors"
                :class="danger ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'"
              >
                {{ confirmText || '确认' }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
    </Transition>
  </Teleport>
</template>
