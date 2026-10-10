import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

/**
 * 懒加载包装：动态 import 的 chunk 加载失败时自动兜底。
 *
 * 为什么需要：路由组件都是 () => import(...) 懒加载。当后端发布新版本后，
 * 旧 chunk 文件名（带 hash）在 CDN/服务器上已不存在，用户停留在旧页面继续
 * 切换 tab 时触发动态 import，会 404 → Promise reject → <router-view>
 * 渲染不出组件 → 整个内容区白屏，且无法自愈。频繁切 tab 会放大触发概率。
 *
 * 策略：失败时先重试一次（覆盖偶发网络抖动）；若判定为「chunk 失效」类错误，
 * 用 sessionStorage 打一次性标记后整页 reload 拉取最新资源（标记防死循环）。
 */
const CHUNK_RELOAD_KEY = 'chunk-reload-once'

/** 动态 import 失效的特征文案（浏览器与构建器措辞不一，合并匹配） */
function isChunkError(err: unknown): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|dynamically imported module/i.test(
    String((err as Error)?.message || err || ''),
  )
}

/**
 * chunk 失效：只刷新一次，避免 404 未修复时死循环。
 * 标记用 sessionStorage（单标签页），换新标签页仍能自愈。
 *
 * 返回 true = 已触发刷新（调用方应停下等待），false = 已经刷过一轮仍不行。
 * 不在回调里抛错，避免变成 unhandledrejection。
 */
function tryReloadOnce(): boolean {
  if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return false
  sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
  window.location.reload()
  return true
}

function lazy(loader: () => Promise<unknown>) {
  return async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const mod = await loader()
        sessionStorage.removeItem(CHUNK_RELOAD_KEY) // 本次成功，清除自愈标记
        return mod as never
      } catch (err) {
        // 最后一次失败才判定：可能是瞬时网络问题，先重试一轮
        if (attempt !== 1) continue
        if (isChunkError(err) && tryReloadOnce()) {
          // 刷新期间返回永不 resolve 的 Promise，让页面停在原状而非白屏
          return new Promise(() => {}) as never
        }
        // 非 chunk 错误，或已刷新过仍失败 → 抛出原始错误
        // （外壳仍在渲染，用户至少能看到导航，错误也留在控制台可排查）
        throw err
      }
    }
    throw new Error('unreachable: lazy loader failed twice')
  }
}

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  /**
   * 滚动行为
   *
   * 账本（meta.selfScroll）把滚动位置交回给组件自己管：它是无限滚动的，
   * router 不知道第几页才够高，只会在目标位置超过已加载内容高度时被静默截断，
   * 用户就落在一个不伦不类的位置。组件的 tryRestoreScroll() 会「不够高就补页」，
   * router 插进来只会打架，所以这里返回 false 让它别动。
   *
   * 其余页面走默认：后退/前进回原位，其它情况回顶部。
   */
  scrollBehavior(to, _from, savedPosition) {
    if (to.meta.selfScroll) return false
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
  routes: [
    {
      path: '/login',
      name: 'Login',
      component: lazy(() => import('@/views/Login.vue')),
      meta: { guest: true, title: '登录' },
    },
    {
      path: '/register',
      name: 'Register',
      component: lazy(() => import('@/views/Register.vue')),
      meta: { guest: true, title: '注册' },
    },
    {
      path: '/onboarding',
      name: 'Onboarding',
      component: lazy(() => import('@/views/Onboarding.vue')),
      meta: { auth: true, title: '初始设置' },
    },
    {
      // 落地页 = 记账。真实使用里 90%+ 的动作是「记一笔」，
      // 首屏应该直接面对输入框，而不是先看统计再去找入口。
      path: '/',
      name: 'QuickEntry',
      component: lazy(() => import('@/views/Home.vue')),
      meta: { auth: true, title: '记一笔' },
    },
    {
      path: '/quick',
      redirect: '/',
    },
    {
      path: '/overview',
      name: 'Dashboard',
      component: lazy(() => import('@/views/Dashboard.vue')),
      // cluster：这一页讲的是「我的钱」，仪表读数在这里才有用
      meta: { auth: true, title: '本月', cluster: true },
    },
    {
      path: '/ledger',
      name: 'Ledger',
      component: lazy(() => import('@/views/Ledger.vue')),
      meta: { auth: true, title: '账本', cluster: true, selfScroll: true },
    },
    {
      path: '/ai',
      name: 'AiChat',
      component: lazy(() => import('@/views/AiChat.vue')),
      meta: { auth: true, title: 'AI 助手', flush: true },
    },
    {
      path: '/import',
      name: 'Import',
      component: lazy(() => import('@/views/Import.vue')),
      meta: { auth: true, title: '导入账单' },
    },
    {
      path: '/assets',
      name: 'Assets',
      component: lazy(() => import('@/views/Assets.vue')),
      meta: { auth: true, title: '资产全景', cluster: true },
    },
    {
      path: '/me',
      name: 'Me',
      component: lazy(() => import('@/views/Me.vue')),
      meta: { auth: true, title: '我的' },
    },
    {
      path: '/settings',
      name: 'Settings',
      component: lazy(() => import('@/views/Settings.vue')),
      meta: { auth: true, title: '设置' },
    },
    {
      path: '/trash',
      name: 'Trash',
      component: lazy(() => import('@/views/Trash.vue')),
      meta: { auth: true, title: '回收站' },
    },
    // 兼容旧 URL 重定向（下线的功能统一收到 /me，那里不再列出）
    { path: '/transactions', redirect: '/ledger' },
    { path: '/stats', redirect: '/ledger' },
    { path: '/analysis', redirect: '/ledger' },
    { path: '/dashboard', redirect: '/overview' },
    { path: '/quick', redirect: '/' },
    { path: '/budget', redirect: '/me' },
    { path: '/goals', redirect: '/me' },
    { path: '/subscriptions', redirect: '/me' },
    { path: '/memories', redirect: '/settings' },
    {
      path: '/admin',
      name: 'Admin',
      component: lazy(() => import('@/views/Admin.vue')),
      meta: { auth: true, title: '管理面板' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'NotFound',
      redirect: '/',
    },
  ],
})

// 路由守卫
router.beforeEach((to, _from, next) => {
  const auth = useAuthStore()
  const token = auth.token || localStorage.getItem('token')

  if (to.meta.auth && !token) {
    next('/login')
  } else if (to.meta.guest && token) {
    next('/')
  } else {
    next()
  }
})

// chunk 加载类错误的最终兜底：router 层面捕获动态 import 失败。
// lazy() 已在组件级重试+刷新，这里兜住其它路径（如 beforeResolve 阶段）抛出的
// 同类错误，避免 unhandledrejection 冒泡且导致导航中断后白屏。
router.onError((error) => {
  if (isChunkError(error)) tryReloadOnce()
})

export default router
