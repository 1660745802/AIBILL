<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useQuickEntry } from '@/composables/useQuickEntry'
import AppIcon from '@/components/ui/AppIcon.vue'
import ToastHost from '@/components/ui/ToastHost.vue'
import ConfirmHost from '@/components/ui/ConfirmHost.vue'
import InstrumentCluster from '@/components/ui/InstrumentCluster.vue'
import { NAV_GROUPS, mobileTabs, type NavGroup } from '@/nav'
import { useInvestmentNav } from '@/composables/useInvestmentNav'
import QuickEntry from '@/components/QuickEntry.vue'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()
const quick = useQuickEntry()
// 「投资」出不出现取决于有没有理财账户，见 useInvestmentNav
const { hasInvestment, refreshInvestmentNav } = useInvestmentNav()

onMounted(async () => {
  if (auth.token && !auth.user) await auth.fetchUser()
  document.addEventListener('keydown', onGlobalKey)
  void refreshInvestmentNav()
})
// 每次换页顺手复核一次（有缓存，不会每次都打接口）：
// 用户在资产页把账户改成理财投资后，侧栏要跟上
watch(() => route.path, () => { void refreshInvestmentNav() })
onUnmounted(() => document.removeEventListener('keydown', onGlobalKey))

/* ── 全局快捷键 ─────────────────────────────────────
   记一笔是唯一的高频动作：让它不依赖「我此刻在哪个页面」。
   ⌘K / N 任何地方都能把它拉出来；`/` 则先给当前页的搜索框
   （账本这种列表页），页面上没有搜索框时才回落到快速录入——
   否则同一个键在两页有两种含义，人会记错。
   只在「不是在打字」时生效，否则会把用户正在输入的内容吃掉。  */
const SHORTCUT_TABS: string[] = ['/ledger', '/overview', '/ai']

function onGlobalKey(e: KeyboardEvent) {
  if (quick.state.open) return // 弹层开着时让位给它自己的 Esc / ↵
  const t = e.target as HTMLElement | null
  const typing = !!t && (
    t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
    || t.isContentEditable
  )
  if (e.metaKey || e.ctrlKey) {
    if (e.key.toLowerCase() === 'k') { e.preventDefault(); quick.open() }
    return
  }
  if (typing || e.altKey) return
  if (e.key === '/') {
    e.preventDefault()
    const search = document.querySelector<HTMLInputElement>('#page-search')
    if (search) search.focus()
    else quick.open()
    return
  }
  if (e.key.toLowerCase() === 'n') { e.preventDefault(); quick.open(); return }
  const n = Number(e.key)
  if (n >= 1 && n <= 3) {
    e.preventDefault()
    router.push(SHORTCUT_TABS[n - 1]!)
  }
}

/* ── 导航结构 ──────────────────────────────────────────
   按功能分组，单一真源在 @/nav.ts（侧栏 / 底栏 /「我的」三处共用）。

   记账是「动作」不是「页面」：桌面端它是侧栏顶部的按钮，手机端是
   右下角 FAB，任意页面 ⌘K / N——都不需要先进导航。

   手机底栏塞不进「组」只能放页面，取 nav.ts 里标了 mobileSlot 的项
   （账本 / 记一笔 / 账户总览 / 本月结算）。这是物理约束，不是又退回频率分层。
   记一笔在 web 端是普通 tab（web 定位是信息整合，不需要突出它）。 */

const groups = computed<NavGroup[]>(() =>
  NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((i) =>
      (!i.adminOnly || auth.isAdmin) && (!i.needsInvestment || hasInvestment.value),
    ),
  })).filter((g) => g.items.length > 0),
)

function isActive(path: string): boolean {
  return route.path === path || route.path.startsWith(path + '/')
}

/** 「我的」是功能索引页，不再是某几个页面的父级——只有停在它自己时才算选中 */
function isMeActive(): boolean {
  return route.path === '/me'
}

const displayName = computed(() => auth.user?.nickname || auth.user?.username || '')
const initial = computed(() => displayName.value.charAt(0).toUpperCase() || '?')

/** 顶部条标题：优先路由 meta，其次从导航结构反查 */
const pageTitle = computed(() => {
  if (route.meta.title) return String(route.meta.title)
  const all = NAV_GROUPS.flatMap((g) => g.items)
  return all.find(i => isActive(i.path))?.label ?? '财务工作台'
})

const today = new Date()
const todayLabel = computed(() =>
  `${today.getMonth() + 1}月${today.getDate()}日 周${'日一二三四五六'[today.getDay()]}`,
)

/** flush 路由（AI 助手）自己管理整屏高度，不加页面留白、不叠仪表 */
const flush = computed(() => route.meta.flush === true)

/**
 * 仪表读数只在「这一页就是在讲我的钱」时出现：账本 / 本月 / 资产。
 *
 * 之前是「登录了就一直显示」，于是邀请码页、系统日志上方挂着一个
 * ¥1,284,356 —— 那是管理员自己的钱，跟这一屏要干的事没有任何关系。
 * 常驻不等于到处常驻：读数是上下文，不是装饰。
 */
const showCluster = computed(() => route.meta.cluster === true)

const railOpen = ref(false)
watch(() => route.path, () => { railOpen.value = false })

/** 手机底部 3 槽，由 nav.ts 的 mobileSlot 标记派生 */
const TABS = computed(() => mobileTabs())
</script>

<template>
  <div class="app-shell">
    <ToastHost />
    <ConfirmHost />

    <!-- 已登录 -->
    <div
      v-if="auth.isAuthenticated && !route.meta.guest"
      class="app-frame"
      :class="{ 'frame-flush': flush }"
    >
      <!-- 桌面侧栏 -->
      <aside class="rail" :class="{ 'rail-open': railOpen }">
        <div class="rail-brand">
          <RouterLink to="/ledger" class="rail-brand-link">
            <span class="rail-mark" aria-hidden="true">账</span>
            <span class="rail-brand-text min-w-0">
              <span class="rail-brand-name">财务工作台</span>
              <span class="rail-brand-user amt">{{ displayName }}</span>
            </span>
          </RouterLink>
        </div>

        <nav class="rail-nav scroll-thin" aria-label="主导航">
          <div v-for="g in groups" :key="g.key" class="rail-group">
            <p class="rail-group-title">{{ g.label }}</p>
            <RouterLink
              v-for="item in g.items"
              :key="item.path"
              :to="item.path"
              class="rail-item"
              :class="{ 'rail-item-on': isActive(item.path) }"
              :title="item.label"
            >
              <AppIcon :name="item.icon" :size="17" />
              <span class="rail-label">{{ item.label }}</span>
            </RouterLink>
          </div>
        </nav>

        <RouterLink to="/me" class="rail-foot" :class="{ 'rail-item-on': isMeActive() }">
          <span class="rail-avatar" aria-hidden="true">{{ initial }}</span>
          <span class="rail-label min-w-0">
            <span class="rail-foot-name">{{ displayName }}</span>
            <span class="rail-foot-role amt">
              {{ auth.isAdmin ? '管理员' : '@' + auth.user?.username }}
            </span>
          </span>
        </RouterLink>
      </aside>

      <!-- 内容区 -->
      <div class="app-body">
        <!-- 手机吸顶条：标题 + 头像（低频项从这里进「我的」） -->
        <header class="topbar">
          <div class="min-w-0 flex-1">
            <h1 class="topbar-title truncate">{{ pageTitle }}</h1>
            <p class="topbar-sub amt">{{ todayLabel }}</p>
          </div>
          <RouterLink to="/me" class="topbar-avatar" :aria-label="`${displayName} 的账户`">{{ initial }}</RouterLink>
        </header>

        <!-- 仪表读数：常驻，但只在讲个人财务的页面。窄屏压成一行吸顶读数条 -->
        <div v-if="showCluster" class="cluster-dock">
          <InstrumentCluster />
        </div>

        <!--
          路由切换过渡：故意不使用 mode="out-in"。
          out-in 要求旧组件离场动画结束后新组件才进场；快速连续切 tab 时离场会被
          下一次路由变更打断，新组件的 enter 丢失，内容区停在空占位导致白屏。
          改为并发过渡：新组件立即挂载进场，旧组件独立离场，互不阻塞，不留空窗。
          注意：此注释放在 RouterView v-slot 之外，避免注释节点被插槽渲染成可见文本。
        -->
        <main class="app-content" :class="flush ? 'app-content-flush' : ''">
          <RouterView v-slot="{ Component, route: viewRoute }">
            <Transition name="rise">
              <component :is="Component" :key="viewRoute.path" />
            </Transition>
          </RouterView>
        </main>
      </div>

      <!-- 手机底部导航：记一笔已降级为普通 tab，不再是突出的 FAB。
           网页承担数据整合，记账主要靠 App 自动记账，手记只是兜底。 -->
      <nav class="tabbar safe-bottom" aria-label="底部导航">
        <RouterLink
          v-for="t in TABS"
          :key="t.path"
          :to="t.path"
          class="tab"
          :class="{ 'tab-on': isActive(t.path) }"
        >
          <AppIcon :name="t.icon" :size="20" :stroke="isActive(t.path) ? 2 : 1.6" />
          <span class="tab-label">{{ t.label }}</span>
        </RouterLink>
      </nav>

      <!-- 快速录入：已经站在记一笔页时不再套一层弹层（Home.vue 会直接聚焦它的输入框） -->
      <QuickEntry
        v-if="quick.state.open && route.path !== '/'"
        @close="quick.close()"
      />
    </div>

    <!-- 未登录 / 访客页 -->
    <div v-else>
      <RouterView />
    </div>
  </div>
</template>

<style scoped>
.app-shell { min-height: 100dvh; background: var(--color-paper); }
.app-frame { display: flex; min-height: 100dvh; }

/* ── 侧栏 ─────────────────────────────────────── */
.rail {
  position: fixed;
  inset-block: 0;
  left: 0;
  z-index: 40;
  width: 232px;
  display: flex;
  flex-direction: column;
  background: var(--color-paper-raised);
  border-right: 1px solid var(--color-rule);
}
@media (max-width: 1023px) { .rail { display: none; } }

.rail-brand {
  padding: 0.875rem 1rem 0.75rem;
  border-bottom: 1px solid var(--color-rule);
  box-shadow: 0 2px 0 -1px var(--color-rule);
}
.rail-brand-link { display: flex; align-items: center; gap: 0.625rem; min-width: 0; }
.rail-mark {
  width: 1.625rem;
  height: 1.625rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-xs);
  background: var(--color-inverse);
  color: var(--color-inverse-fg);
  font-size: 0.75rem;
  font-weight: 600;
}
.rail-brand-name {
  display: block;
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--color-ink-1);
  line-height: 1.25;
}
.rail-brand-user {
  display: block;
  font-size: 0.625rem;
  color: var(--color-ink-3);
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-nav {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.5rem 0.625rem 1rem;
}
.rail-group + .rail-group {
  margin-top: 0.75rem;
  padding-top: 0.625rem;
  border-top: 1px solid var(--color-rule-faint);
}
.rail-group-title {
  font-size: 0.625rem;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--color-ink-4);
  padding: 0 0.5rem;
  margin-bottom: 0.25rem;
}
.rail-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.4375rem 0.5rem;
  border-radius: var(--radius-sm);
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-ink-3);
  transition: background-color 0.13s ease, color 0.13s ease;
}
.rail-item:hover { background: var(--color-paper-hover); color: var(--color-ink-1); }
/* 选中 = 左侧指针条 + 深色字，不用填充药丸 */
.rail-item-on { color: var(--color-ink-1); background: var(--color-paper-hover); }
.rail-item-on::before {
  content: '';
  position: absolute;
  left: -0.625rem;
  top: 50%;
  transform: translateY(-50%);
  width: 2px;
  height: 1.125rem;
  background: var(--color-action);
}
.rail-label { flex: 1; min-width: 0; }

.rail-foot {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.625rem 1rem;
  border-top: 1px solid var(--color-rule);
  color: var(--color-ink-3);
  transition: background-color 0.13s;
}
.rail-foot:hover { background: var(--color-paper-hover); }
.rail-avatar {
  width: 1.625rem;
  height: 1.625rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--color-paper-sunk);
  border: 1px solid var(--color-rule);
  color: var(--color-ink-1);
  font-size: 0.6875rem;
  font-weight: 600;
}
.rail-foot-name {
  display: block;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-ink-1);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rail-foot-role { display: block; font-size: 0.625rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* ── 内容 ─────────────────────────────────────── */
.app-body { flex: 1; min-width: 0; margin-left: 232px; }
@media (max-width: 1023px) { .app-body { margin-left: 0; } }

/* 仪表停靠：宽屏跟着内容滚，窄屏吸顶常驻 */
.cluster-dock { max-width: 68rem; margin-inline: auto; padding: 1.5rem 1rem 0; }
@media (min-width: 1024px) { .cluster-dock { padding: 1.75rem 2rem 0; } }
@media (max-width: 1023px) {
  .cluster-dock {
    position: sticky;
    top: 0;
    z-index: 25;
    padding: 0;
    background: var(--color-paper);
  }
}

.app-content {
  position: relative;
  max-width: 68rem;
  margin-inline: auto;
  padding: 1.25rem 1rem 6rem;
}
@media (min-width: 1024px) { .app-content { padding: 1.5rem 2rem 3rem; } }
.app-content-flush { padding: 0 0 4.5rem; max-width: none; }

/* ── 手机吸顶条 ─────────────────────────────────── */
.topbar { display: none; }
@media (max-width: 1023px) {
  .topbar {
    position: sticky;
    top: 0;
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 0.625rem;
    padding: 0.5rem 1rem;
    background: var(--color-paper);
    border-bottom: 1px solid var(--color-rule);
  }
}
/* flush 页面自带报头，不叠外壳吸顶条 */
.frame-flush .topbar { display: none !important; }
.topbar-title {
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--color-ink-1);
  line-height: 1.25;
}
.topbar-sub { font-size: 0.625rem; color: var(--color-ink-3); line-height: 1.3; }
.topbar-avatar {
  width: 1.75rem;
  height: 1.75rem;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  background: var(--color-inverse);
  color: var(--color-inverse-fg);
  font-size: 0.6875rem;
  font-weight: 600;
}

/* ── 底部 Tab：3 槽 + 右下 FAB ─────────────────── */
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  display: none;
  align-items: center;
  gap: 0.25rem;
  padding: 0.3125rem 0.5rem 0.3125rem;
  background: color-mix(in srgb, var(--color-paper-raised) 94%, transparent);
  backdrop-filter: blur(12px);
  border-top: 1px solid var(--color-rule);
}
@media (max-width: 1023px) { .tabbar { display: flex; } }

.tab {
  display: flex;
  flex: 1;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  color: var(--color-ink-4);
  transition: color 0.13s;
}
.tab-on { color: var(--color-ink-1); }
.tab-label { font-size: 0.625rem; font-weight: 500; line-height: 1.2; }

/* 内容底部给导航让位 */
@media (max-width: 1023px) {
  .app-content, .app-content-flush {
    padding-bottom: calc(4.25rem + env(safe-area-inset-bottom, 0px));
  }
}
</style>
