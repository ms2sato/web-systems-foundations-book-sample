import { testDatabaseUrl } from './test-db.js'

// テスト用環境変数設定。DB はデモ用の app ではなくテスト専用の app_test に向ける
process.env.DATABASE_URL = testDatabaseUrl()
process.env.REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
