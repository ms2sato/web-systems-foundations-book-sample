import { PrismaClient, Prisma } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/app'

// PostgreSQLプールの作成
const pool = new pg.Pool({ connectionString: DATABASE_URL })
const adapter = new PrismaPg(pool)

// Prismaクライアントのシングルトンインスタンス
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma = globalForPrisma.prisma ?? new PrismaClient({ adapter })

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma
}

// Prisma型のエクスポート
export { Prisma }
export type { Archive, Thumbnail, UploadedFile, ArchiveFile, ArchiveStatus } from '@prisma/client'
