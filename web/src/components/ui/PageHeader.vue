<script setup lang="ts">
/**
 * 页头（报头）。桌面吸顶 + 账本双线压边；手机端由 AppShell 提供吸顶条，此处不吸顶。
 */
withDefaults(defineProps<{
  title: string
  subtitle?: string
  sticky?: boolean
}>(), { sticky: true })
</script>

<template>
  <header
    class="page-head"
    :class="[sticky ? 'page-head-sticky' : '']"
  >
    <div class="min-w-0 flex-1">
      <h1 class="page-title">{{ title }}</h1>
      <p v-if="subtitle" class="page-sub">{{ subtitle }}</p>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <slot name="meta" />
      <slot name="actions" />
    </div>
  </header>
</template>

<style scoped>
/**
 * 手机端不吸顶。
 * 外壳已经有一条 sticky top:0 的报头条（.topbar）且它已经显示了页面标题，
 * 两者都是 sticky top:0 会直接叠在一起——PageHeader 的标题被压在下面看不见，
 * 只剩副标题露出来（实测 /me、/ledger 手机端都是这样）。
 * 桌面没有外壳报头条，所以 >=1024 才由这里吸顶。
 */
.page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 0.75rem;
  margin-bottom: 1.25rem;
  border-bottom: 1px solid var(--color-rule);
}
@media (min-width: 1024px) {
  .page-head-sticky {
    position: sticky;
    top: 0;
    z-index: 20;
    background: var(--color-paper);
    /* 负边距必须与外壳内容区的左右内边距一致，否则会撑出横向滚动 */
    margin-inline: -1rem;
    padding-inline: 1rem;
    padding-top: 0.5rem;
    padding-bottom: 0.75rem;
  }
}
.page-title {
  font-size: 1.0625rem;
  font-weight: 650;
  color: var(--color-ink-1);
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.page-sub {
  font-size: 0.75rem;
  color: var(--color-ink-3);
  margin-top: 0.125rem;
  line-height: 1.4;
}

/* 平板/手机：外壳吸顶条已经显示页面标题，这里不再重复一遍；
   底部分隔线也交给吸顶条的双线压边。 */
@media (max-width: 1023px) {
  .page-head {
    padding-bottom: 0.5rem;
    margin-bottom: 1rem;
    border-bottom: 0;
  }
  .page-head-sticky {
    margin-inline: 0;
    padding-inline: 0;
    padding-top: 0;
  }
  .page-title { display: none; }
  .page-sub { margin-top: 0; }
}

@media (min-width: 1024px) {
  .page-head-sticky {
    margin-inline: -2rem;
    padding-inline: 2rem;
  }
}
</style>
