import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
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

  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('token')
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
    login,
    register,
    fetchUser,
    logout,
  }
})
