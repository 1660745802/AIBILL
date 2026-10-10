import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { PERIOD_KEY } from './period'
import { LEDGER_STATE_KEY } from './ledger'
import { QUICK_DRAFT_KEY } from '@/composables/useQuickEntry'
import api from '@/api/index'

export interface User {
  id: number
  username: string
  nickname: string | null
  role: 'admin' | 'user'
}

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string | null>(localStorage.getItem('token'))
  const user = ref<User | null>(null)

  const isAuthenticated = computed(() => !!token.value)
  const isAdmin = computed(() => user.value?.role === 'admin')

  function setAuth(newToken: string, newUser: User) {
    token.value = newToken
    user.value = newUser
    localStorage.setItem('token', newToken)
  }

  /**
   * 登出：除了 token，还要清掉所有带用户输入的本地持久化。
   *
   * 不清会怎样：自部署小范围多人常常共用一台设备/浏览器，
   * A 登出后 B 登录，B 的账本会继承 A 的最后搜索词、筛选、查看月份，
   * 甚至 A 记到一半没提交的草稿句子。这些都不是账目数据，
   * 但都是 A 输入的内容，sessionStorage 只在关标签页时才清，登出不算。
   */
  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('token')
    localStorage.removeItem(PERIOD_KEY)
    sessionStorage.removeItem(LEDGER_STATE_KEY)
    sessionStorage.removeItem(QUICK_DRAFT_KEY)
  }

  async function login(username: string, password: string) {
    const { data } = await api.post('/auth/login', { username, password })
    if (data.code === 0) {
      setAuth(data.data.token, data.data.user)
      return data.data
    }
    throw new Error(data.message || '登录失败')
  }

  async function register(username: string, password: string, inviteCode: string, nickname?: string) {
    const { data } = await api.post('/auth/register', {
      username,
      password,
      invite_code: inviteCode,
      nickname: nickname || undefined,
    })
    if (data.code === 0) {
      setAuth(data.data.token, data.data.user)
      return data.data
    }
    throw new Error(data.message || '注册失败')
  }

  async function fetchUser() {
    if (!token.value) return
    try {
      const { data } = await api.get('/auth/me')
      if (data.code === 0) {
        user.value = data.data.user
      } else {
        logout()
      }
    } catch {
      logout()
    }
  }

  return {
    token,
    user,
    isAuthenticated,
    isAdmin,
    setAuth,
    login,
    register,
    fetchUser,
    logout,
  }
})
