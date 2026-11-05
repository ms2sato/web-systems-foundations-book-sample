import { execFileSync } from 'node:child_process'
import { testDatabaseUrl } from './test-db.js'

// テスト開始前に一度だけ、テスト専用 DB（app_test）へ最新のスキーマを適用する
export default function setup() {
  execFileSync('npx', ['prisma', 'db', 'push'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl() },
    stdio: 'inherit',
  })
}
