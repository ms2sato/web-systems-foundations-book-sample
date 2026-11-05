import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/__tests__/setup.ts'],
    globalSetup: ['src/__tests__/global-setup.ts'],
    // テスト用DBを全ファイルで共有し、beforeEachでテーブルを空にしているため、
    // ファイルを並列実行すると互いのデータを消し合う（テストファイル間で直列化する）
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
})
