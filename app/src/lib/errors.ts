import { Prisma } from '@prisma/client'

// PostgreSQL の SQLSTATE のうち、リトライで解消しうるもの
// 55P03: ロック取得失敗（FOR UPDATE NOWAIT）/ 40P01: デッドロック
const RETRYABLE_SQLSTATES = new Set(['55P03', '40P01'])

// ネットワークの一時的な接続失敗を表す Node.js のエラーコード。
// ENOTFOUND を含めるのは、このシステムの接続先が内部のサービス名であり、
// 名前が引けない＝依存サービスの停止中（一時障害）を意味するため
const RETRYABLE_NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND'])

// $queryRaw の失敗（P2010）に含まれる PostgreSQL の SQLSTATE を取り出す
function sqlStateOf(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = error.meta as { driverAdapterError?: { cause?: { code?: unknown } } } | undefined
  const code = meta?.driverAdapterError?.cause?.code
  return typeof code === 'string' ? code : undefined
}

// AWS SDK のエラーが持つ HTTP ステータスコードを取り出す
function httpStatusOf(error: Error): number | undefined {
  const status = (error as { $metadata?: { httpStatusCode?: unknown } }).$metadata?.httpStatusCode
  return typeof status === 'number' ? status : undefined
}

// リトライ可能な例外かどうかを判定する。
// 「一時的な状況が原因で、時間を置いてやり直せば成功しうるか」が分類の基準。
// ここで挙げているのは代表例で、網羅は業務で使う外部システムごとに設計する
export function isRetryableError(error: unknown): boolean {
  // DB: ロック競合・デッドロック（時間を置けば解消する）
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2034') {
      return true
    }
    if (error.code === 'P2010' && RETRYABLE_SQLSTATES.has(sqlStateOf(error) ?? '')) {
      return true
    }
    // その他の DB エラー（制約違反など）はやり直しても結果が変わらない
    return false
  }

  // DB: 接続の確立に失敗
  if (error instanceof Prisma.PrismaClientInitializationError) {
    return true
  }

  if (error instanceof Error) {
    // ネットワーク: 一時的な接続失敗（S3 や Redis への通信で起きる）
    if ('code' in error && typeof error.code === 'string' && RETRYABLE_NETWORK_CODES.has(error.code)) {
      return true
    }

    // S3（AWS SDK）: サーバー側の一時エラー（5xx）とスロットリング（429）
    const status = httpStatusOf(error)
    if (status !== undefined && (status >= 500 || status === 429)) {
      return true
    }
  }

  // それ以外はリトライ不可
  return false
}
