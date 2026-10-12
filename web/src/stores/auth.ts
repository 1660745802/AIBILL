import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { PERIOD_KEY, usePeriodStore } from './period'
import { LEDGER_STATE_KEY, useLedgerStore } from './ledger'
import { QUICK_DRAFT_KEY, useQuickEntry } from '@/composables/useQuickEntry'
import { useClusterStore } from './cluster'
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
   * 登出：除了 token，还要清掉所有带用户输入的本地持久化**与内存态**。
   *
   * 不清会怎样：自部署小范围多人常常共用一台设备/浏览器，
   * A 登出后 B 登录，B 的账本会继承 A 的最后搜索词、筛选、查看月份，
   * 甚至 A 记到一半没提交的草稿句子。这些都不是账目数据，
   * 但都是 A 输入的内容，sessionStorage 只在关标签页时才清，登出不算。
   *
   * ⚠️ **光清存储不够**：Pinia store 是同一标签页内的单例，而登出走前端路由
   * （不是 401 那种整页刷新），A 的搜索词/月份/仪表读数会原样留在内存里——
   * B 一登录就看到了。所以这里必须同时把各 store 归位。
   */
  function logout() {
    token.value = null
    user.value = null
    localStorage.removeItem('token')
    localStorage.removeItem(PERIOD_KEY)
    sessionStorage.removeItem(LEDGER_STATE_KEY)
    sessionStorage.removeItem(QUICK_DRAFT_KEY)
    useLedgerStore().reset()
    usePeriodStore().reset()
    useClusterStore().reset()
    useQuickEntry().close()
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
        // HTTP 200 + code != 0（1002/1005/1006 这类）：令牌确实不可用了
        logout()
      }
    } catch (e: any) {
      /*
       * 只在**令牌真的无效**（401）时清会话。
       * 以前是不管什么错都 logout()：断网/超时/后端重启一次，用户的 token 就没了，
       * 下次打开还得重新登录——而 401 的拦截器已经把 token 清掉并跳登录页了，
       * 这里再清一次是多余的，只会把「临时网络抖动」升级成「被踢下线」。
       */
      if (e?.response?.status === 401) logout()
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
