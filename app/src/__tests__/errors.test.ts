import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { isRetryableError } from '../lib/errors.js'

function knownRequestError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('test error', {
    code,
    clientVersion: '0.0.0',
    meta,
  })
}

function sqlStateMeta(sqlState: string): Record<string, unknown> {
  return { driverAdapterError: { cause: { code: sqlState } } }
}

describe('isRetryableError（リトライ可否の分類）', () => {
  describe('DB エラー', () => {
    it('トランザクション競合（P2034）はリトライ可能', () => {
      expect(isRetryableError(knownRequestError('P2034'))).toBe(true)
    })

    it('ロック取得失敗（P2010 + SQLSTATE 55P03）はリトライ可能', () => {
      expect(isRetryableError(knownRequestError('P2010', sqlStateMeta('55P03')))).toBe(true)
    })

    it('デッドロック（P2010 + SQLSTATE 40P01）はリトライ可能', () => {
      expect(isRetryableError(knownRequestError('P2010', sqlStateMeta('40P01')))).toBe(true)
    })

    it('その他の raw クエリ失敗（P2010 + 一意制約違反など）はリトライ不可', () => {
      expect(isRetryableError(knownRequestError('P2010', sqlStateMeta('23505')))).toBe(false)
    })

    it('一意制約違反（P2002）はリトライ不可', () => {
      expect(isRetryableError(knownRequestError('P2002'))).toBe(false)
    })

    it('DB 接続の確立失敗はリトライ可能', () => {
      const error = new Prisma.PrismaClientInitializationError('cannot connect', '0.0.0')
      expect(isRetryableError(error)).toBe(true)
    })
  })

  describe('ネットワークエラー', () => {
    it('一時的な接続失敗（ECONNRESET / ECONNREFUSED / ETIMEDOUT / ENOTFOUND）はリトライ可能', () => {
      for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']) {
        expect(isRetryableError(Object.assign(new Error('network'), { code }))).toBe(true)
      }
    })

    it('ネットワーク以外のシステムエラー（ENOENT）はリトライ不可', () => {
      expect(isRetryableError(Object.assign(new Error('no such file'), { code: 'ENOENT' }))).toBe(false)
    })
  })

  describe('S3（AWS SDK）のエラー', () => {
    it('サーバー側エラー（503）とスロットリング（429）はリトライ可能', () => {
      for (const httpStatusCode of [500, 503, 429]) {
        const error = Object.assign(new Error('s3 error'), { $metadata: { httpStatusCode } })
        expect(isRetryableError(error)).toBe(true)
      }
    })

    it('クライアント側エラー（404 など）はリトライ不可', () => {
      const error = Object.assign(new Error('not found'), { $metadata: { httpStatusCode: 404 } })
      expect(isRetryableError(error)).toBe(false)
    })
  })

  it('分類できないものはリトライ不可に倒す', () => {
    expect(isRetryableError(new Error('unknown'))).toBe(false)
    expect(isRetryableError('string error')).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })
})
