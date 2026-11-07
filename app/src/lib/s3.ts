import { S3Client } from '@aws-sdk/client-s3'

export const AWS_ENDPOINT = process.env.AWS_ENDPOINT || 'http://localhost:4566'
export const S3_BUCKET = 'uploads'

export const s3Client = new S3Client({
  endpoint: AWS_ENDPOINT,
  region: process.env.AWS_REGION || 'ap-northeast-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'test',
  },
  forcePathStyle: true,
})
