<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const inviteCode = ref('')
const nickname = ref('')
const loading = ref(false)
const error = ref('')

async function handleRegister() {
  error.value = ''

  if (!username.value || !password.value || !inviteCode.value) {
    error.value = '请填写所有必填项'
    return
  }
  if (password.value !== confirmPassword.value) {
    error.value = '两次密码输入不一致'
    return
  }
  if (password.value.length < 6) {
    error.value = '密码至少6个字符'
    return
  }

  loading.value = true
  try {
    await auth.register(username.value, password.value, inviteCode.value, nickname.value || undefined)
    router.push('/')
  } catch (e: any) {
    error.value = e.message || '注册失败'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center bg-gray-50 px-4">
    <div class="w-full max-w-sm">
      <div class="text-center mb-8">
        <h1 class="text-2xl font-bold text-gray-900">注册账号</h1>
        <p class="mt-2 text-sm text-gray-500">需要邀请码才能注册</p>
      </div>

      <form @submit.prevent="handleRegister" class="bg-white shadow-sm rounded-lg p-6 space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">邀请码 *</label>
          <input
            v-model="inviteCode"
            type="text"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="请输入邀请码"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">用户名 *</label>
          <input
            v-model="username"
            type="text"
            autocomplete="username"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="3-20个字符，字母数字下划线"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">昵称</label>
          <input
            v-model="nickname"
            type="text"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="选填，用于显示"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码 *</label>
          <input
            v-model="password"
            type="password"
            autocomplete="new-password"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="至少6个字符"
          />
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">确认密码 *</label>
          <input
            v-model="confirmPassword"
            type="password"
            autocomplete="new-password"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            placeholder="再次输入密码"
          />
        </div>

        <div v-if="error" class="text-sm text-red-600 bg-red-50 p-2 rounded">
          {{ error }}
        </div>

        <button
          type="submit"
          :disabled="loading"
          class="w-full py-2 px-4 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {{ loading ? '注册中...' : '注册' }}
        </button>

        <p class="text-center text-sm text-gray-500">
          已有账号？
          <router-link to="/login" class="text-blue-600 hover:underline">登录</router-link>
        </p>
      </form>
    </div>
  </div>
</template>
