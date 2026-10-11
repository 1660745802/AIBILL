import axios from 'axios'
import { useToast } from '@/composables/useToast'

/**
 * 单次请求的逃生口：默认所有失败都会自动弹 toast；
 * 确实需要自己接管提示语时，调用方传 `{ skipErrorToast: true }`。
 */
declare module 'axios' {
  export interface AxiosRequestConfig {
    skipErrorToast?: boolean
  }
}

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor: auto-inject JWT token
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  },
)

/**
 * 取后端给的那句话。
 *
 * 绝大多数业务失败都同时设了非 2xx 状态码（97 处 code!==0 里95 处如此），
 * 所以会走 axios 的抛错分支，message 就在 `response.data.message` 里。
 * 另有两处例外：ai.ts 的「AI 解析失败 / 返回格式异常」刻意回 HTTP 200 +
 * code 5001/5002，让前端能走自己的分支渲染（AiChat 把提示作为对话气泡显示），
 * 这两处不靠拦截器，拦截器也不会去抢。
 *
 * 同时兼容 Fastify 默认错误体 `{statusCode, error, message}`——同字段名，
 * 因此服务端删掉 onSend 自动包装后这里不用改。
 */
function friendlyMessage(error: any): string {
  const body = error?.response?.data
  if (body && typeof body.message === 'string' && body.message.trim()) {
    return body.message
  }
  // 超时 / 断网：压根没有 response
  if (error?.code === 'ECONNABORTED') return '请求超时，请检查网络后重试'
  if (!error?.response) return '网络异常，请稍后重试'
  const map: Record<number, string> = {
    401: '登录已过期，请重新登录',
    403: '没有权限执行该操作',
    404: '请求的资源不存在',
    500: '服务器内部错误',
  }
  return map[error.response.status] || `请求失败（${error.response.status}）`
}

/**
 * Response interceptor: handle common errors
 *
 * 失败一律在这里上报，业务代码的 catch 只负责状态回滚（rollback / loading=false）。
 * 之前有 40 处 `catch { /* ignore *\/ }` 把后端准备好的 message 整个丢掉，
 * 用户点完「永久删除」这类破坏性操作后得不到任何反馈。
 *
 * 需要自己控制提示语时可以传 `{ skipErrorToast: true }`，由调用方接管。
 */
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // 清理 token 并跳转（同步操作）
      localStorage.removeItem('token')
      const currentPath = window.location.pathname
      if (currentPath !== '/login' && currentPath !== '/register') {
        window.location.replace('/login')
      }
    } else if (!error.config?.skipErrorToast) {
      useToast().error(friendlyMessage(error))
    }
    return Promise.reject(error)
  },
)

export default api
