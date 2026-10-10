<script setup lang="ts">
/**
 * 仪表读数 · 仪表面
 *
 * 它同时是三件东西，这是它常驻的理由：
 *   1. 读数：不管在哪一页，「我现在什么状况」一眼可见
 *   2. 导航：点任一读数直接去对应详情（不是装饰图表）
 *   3. 周期：当前查看的月份是全局状态，控件长在仪表上，不会忘记自己在看哪个月
 *
 * 仪表面恒为深色——真实仪表盘在日光下也是黑面。个性来自深色面板与浅色
 * 页面的对比和刻度结构，不来自「把整个 App 变暗」。
 */
import { onMounted, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useClusterStore } from '@/stores/cluster'
import { usePeriodStore } from '@/stores/period'
import Gauge from './Gauge.vue'
import AppIcon from './AppIcon.vue'

const router = useRouter()
const cluster = useClusterStore()
const period = usePeriodStore()

onMounted(() => cluster.load())

/** 读数格式：≥1 万不带小数（那两位在这个量级是噪声），以下保留分位 */
function reading(cents: number): string {
  const yuan = Math.abs(cents) / 100
  const s = yuan >= 10000
    ? Math.round(yuan).toLocaleString('zh-CN')
    : yuan.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${cents < 0 ? '−' : ''}¥${s}`
}

/** 窄屏读数：整串千分位放不下 1/4 屏宽度，会被截成「¥1,284…」。
   截断比缩写更糟——看的人不知道被吃掉的是万还是十万。改用万/k 写法。 */
function readingCompact(cents: number): string {
  const yuan = Math.abs(cents) / 100
  const sign = cents < 0 ? '−' : ''
  if (yuan >= 100000000) return `${sign}¥${(yuan / 100000000).toFixed(2)}亿`
  if (yuan >= 10000) return `${sign}¥${(yuan / 10000).toFixed(1)}万`
  if (yuan >= 1000) return `${sign}¥${(yuan / 1000).toFixed(1)}k`
  return `${sign}¥${yuan.toFixed(0)}`
}

const ASSET_LABEL: Record<string, string> = {
  liquid: '活期', savings: '定期', investment: '投资',
  property: '不动产', credit: '信用卡', loan: '贷款', other: '其他',
}

/** 构成条：颜色按序取仪表语义色，不用彩虹色 */
const SPLIT_COLORS = [
  'var(--color-readout)', 'var(--color-notch-on)',
  'var(--color-amber)', 'var(--color-ok)',
]
const splitSegments = computed(() =>
  cluster.assetSplit
    .slice(0, 4)
    .map((r: any, i: number) => ({
      key: r.key,
      label: ASSET_LABEL[r.key] ?? '其他',
      percent: r.percent,
      color: SPLIT_COLORS[i % SPLIT_COLORS.length],
    })),
)

const savingsText = computed(() => {
  const r = cluster.savingsRate
  if (cluster.monthIncome <= 0) return '—'
  return `${r >= 0 ? '' : '−'}${Math.abs(r).toFixed(0)}%`
})
const savingsToneClass = computed(() => ({
  ok: 'readout-ok', amber: 'readout-amber', redline: 'readout-redline', neutral: '',
}[cluster.savingsTone]))

const expenseText = computed(() => reading(cluster.monthExpense))
const changeText = computed(() => {
  const c = cluster.expenseChange
  if (c == null) return '无上月对照'
  return `${c >= 0 ? '+' : '−'}${Math.abs(c)}% 较上月`
})

/* 点读数 = 去对应详情 */
const goAssets = () => router.push('/assets')
const goOverview = () => router.push('/overview')
const goExpense = () => router.push('/ledger?type=expense')
</script>

<template>
  <!-- 宽屏：整块仪表面 -->
  <section class="bezel cluster" aria-label="仪表读数">
    <!-- 读数 1 净资产 -->
    <div class="bezel-cell cluster-c1">
      <p class="readout-label">
        净资产
        <button class="cluster-go" :aria-label="`查看资产全景`" @click="goAssets">
          <AppIcon name="chevronRight" :size="12" :stroke="2" />
        </button>
      </p>
      <strong class="readout-value readout-lead" :class="{ 'readout-redline': cluster.netNegative }">
        <span class="val-full">{{ reading(cluster.netWorth) }}</span>
        <span class="val-compact">{{ readingCompact(cluster.netWorth) }}</span>
      </strong>
      <!-- 构成条：这里放横条而不是刻度带——量程是「占比」，指针无意义 -->
      <div v-if="splitSegments.length" class="cluster-split" aria-hidden="true">
        <span
          v-for="s in splitSegments"
          :key="s.key"
          :style="{ width: `${s.percent}%`, background: s.color }"
        />
      </div>
      <p v-if="splitSegments.length" class="readout-sub cluster-split-legend">
        <span v-for="s in splitSegments" :key="s.key" class="cluster-legend-item">
          <i :style="{ background: s.color }" />{{ s.label }} {{ s.percent.toFixed(0) }}%
        </span>
      </p>
      <p v-else class="readout-sub">还没有账户</p>
    </div>

    <!-- 读数 2 储蓄率：量程 0–100%，目标 30% 有参照物 -->
    <div class="bezel-cell cluster-c2">
      <p class="readout-label">
        储蓄率
        <button class="cluster-go" :aria-label="`查看本月`" @click="goOverview">
          <AppIcon name="chevronRight" :size="12" :stroke="2" />
        </button>
      </p>
      <strong class="readout-value" :class="savingsToneClass">{{ savingsText }}</strong>      <Gauge
        :pos="Math.max(0, Math.min(100, cluster.savingsRate))"
        :tone="cluster.savingsTone"
        :target="30"
        target-label="目标 30%"
        min-label="0"
        :max-label="`本月结余 ${reading(cluster.monthBalance)}`"
      />
    </div>

    <!-- 读数 3 本月支出 vs 上月：量程 0–150%，红区 120% 起 -->
    <div class="bezel-cell cluster-c3">
      <p class="readout-label">
        本月支出
        <button class="cluster-go" :aria-label="`查看账本`" @click="goExpense">
          <AppIcon name="chevronRight" :size="12" :stroke="2" />
        </button>
      </p>
      <strong class="readout-value">
        <span class="val-full">{{ expenseText }}</span>
        <span class="val-compact">{{ readingCompact(cluster.monthExpense) }}</span>
      </strong>
      <Gauge
        :pos="cluster.expenseGaugePos"
        :tone="cluster.expenseTone"
        :red-start="120 / 1.5"
        :target="100 / 1.5"
        target-label="与上月持平"
        min-label="−50%"
        max-label="+50%"
      />
      <p class="readout-sub" :class="{
        'readout-amber': cluster.expenseTone === 'amber',
        'readout-redline': cluster.expenseTone === 'redline',
      }">{{ changeText }}</p>
    </div>

    <!-- 周期 + 新鲜度：仪表自报数据年龄，不让人猜 -->
    <div class="bezel-cell cluster-c4">
      <p class="readout-label">查看周期</p>
      <div class="cluster-period">
        <button class="cluster-step" aria-label="上个月" @click="period.shift(-1)">
          <AppIcon name="chevronLeft" :size="14" :stroke="2" />
        </button>
        <span class="cluster-period-label amt">{{ period.year }}<i>/{{ String(period.month).padStart(2, '0') }}</i></span>
        <button
          class="cluster-step"
          aria-label="下个月"
          :disabled="period.isCurrent"
          @click="period.shift(1)"
        >
          <AppIcon name="chevronRight" :size="14" :stroke="2" />
        </button>
      </div>
      <p v-if="!period.isCurrent" class="cluster-back">
        <button class="cluster-back-btn" @click="period.toCurrent()">回到本月</button>
      </p>
      <p v-else class="readout-sub" />
      <button
        class="cluster-fresh"
        :disabled="cluster.loading"
        :aria-label="`更新读数，${cluster.freshLabel}`"
        @click="cluster.load(true)"
      >
        <AppIcon name="refresh" :size="11" :stroke="2" :class="{ 'animate-spin': cluster.loading }" />
        {{ cluster.freshLabel }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.cluster {
  display: grid;
  grid-template-columns: 1.35fr 1fr 1fr auto;
  overflow: hidden;
}

/* 读数 1 稍宽：它带构成条，信息量最大 */
.cluster-c1 { min-width: 15rem; }

/* 宽窄屏切换读数写法：不用 JS 监听断点，两份都在 DOM 里由 CSS 选 */
.val-compact { display: none; }

.readout-lead { font-size: 1.5rem; margin-top: 0.375rem; }
.cluster-c2 .readout-value,
.cluster-c3 .readout-value { font-size: 1.25rem; margin-top: 0.375rem; }

/* 读数右上角的「去详情」小箭头 */
.cluster-go {
  color: var(--color-readout-3);
  display: inline-flex;
  transition: color 0.13s, transform 0.13s;
}
.cluster-go:hover { color: var(--color-readout); transform: translateX(1px); }

/* 资产构成横条 */
.cluster-split {
  display: flex;
  height: 3px;
  gap: 1px;
  margin-top: 0.625rem;
  border-radius: 1px;
  overflow: hidden;
}
.cluster-split span { display: block; min-width: 2px; }
.cluster-split-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem 0.75rem;
  margin-top: 0.375rem;
  font-size: 0.625rem;
}
.cluster-legend-item { display: inline-flex; align-items: center; gap: 0.25rem; }
.cluster-legend-item i { width: 5px; height: 5px; border-radius: 1px; }

/* 周期控件 */
.cluster-c4 { min-width: 11.5rem; }
.cluster-period {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  margin-top: 0.3125rem;
}
.cluster-step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.375rem;
  height: 1.375rem;
  border-radius: 2px;
  color: var(--color-readout-2);
  transition: background-color 0.13s, color 0.13s;
}
.cluster-step:hover:not(:disabled) { background: color-mix(in srgb, var(--color-readout) 10%, transparent); color: var(--color-readout); }
.cluster-step:disabled { opacity: 0.28; cursor: not-allowed; }
.cluster-period-label {
  font-size: 0.9375rem;
  font-weight: 500;
  color: var(--color-readout);
  min-width: 4.25rem;
  text-align: center;
  letter-spacing: -0.02em;
}
.cluster-period-label i { color: var(--color-readout-2); font-style: normal; }
.cluster-back { margin-top: 0.25rem; height: 1.125rem; }
.cluster-back-btn {
  font-size: 0.625rem;
  font-weight: 600;
  color: var(--color-amber);
  padding: 0.125rem 0.375rem;
  margin-left: -0.375rem;
  border-radius: 2px;
  transition: background-color 0.13s;
}
.cluster-back-btn:hover { background: color-mix(in srgb, var(--color-amber) 18%, transparent); }

/* 新鲜度 + 手动刷新 */
.cluster-fresh {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  margin-top: 0.3125rem;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  color: var(--color-readout-3);
  transition: color 0.13s;
}
.cluster-fresh:hover:not(:disabled) { color: var(--color-readout-2); }
.cluster-fresh:disabled { cursor: default; }

/* 窄屏：压成一行读数条，3 个数字仍然可点 */
@media (max-width: 1023px) {
  .cluster {
    grid-template-columns: 1.1fr 1fr 1fr auto;
    border-radius: 0;
    border-left: 0;
    border-right: 0;
  }
  .cluster-c1 { min-width: 0; }
  .cluster-c2, .cluster-c3 { padding-inline: 0.625rem; }
  .cluster-c4 { min-width: 0; padding-inline: 0.5rem; }
  .readout-lead, .cluster-c2 .readout-value, .cluster-c3 .readout-value { font-size: 0.9375rem; }
  .cluster-split, .cluster-split-legend, .gauge-scale, .cluster-fresh, .gauge-target-label { display: none; }
  .cluster-period-label { font-size: 0.8125rem; min-width: 3.25rem; }
  .val-full { display: none; }
  .val-compact { display: inline; }
}
@media (max-width: 400px) {
  .cluster-c1 .readout-value { font-size: 0.875rem; }
  .cluster-back { display: none; }
  .readout-label { font-size: 0.5625rem; letter-spacing: 0.06em; }
  .bezel-cell { padding: 0.625rem 0.5rem 0.5rem; }
}
</style>
