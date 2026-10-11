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
  },
})
