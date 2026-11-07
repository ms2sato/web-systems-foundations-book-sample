// デモ用 DB（app）と同じ Postgres 内にある、テスト専用 DB（app_test）への接続 URL を返す
export function testDatabaseUrl(): string {
  const url = new URL(process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/app')
  url.pathname = '/app_test'
  return url.toString()
}
