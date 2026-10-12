import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    testTimeout: 10000,
    // 用例自己 stub 的全局（主要是 fetch）在**每个用例结束后**自动还原，
    // 不靠各文件的 finally/afterEach 手写——漏一处就会污染后面的用例。
    // setup.ts 里那道「禁止真实外发」的 fetch 包装因此不会被某个 stub 吃掉不还。
    unstubGlobals: true,
    // 固定时区：时区归一/「今天」这类护栏在 TZ=+08 的开发机上会**假绿**（变异测试实测过）。
    // 统一在 UTC 下跑，才能让「无时区串按北京时间解释」这类断言真的在断言。
    env: { TZ: 'UTC' },
  },
})
