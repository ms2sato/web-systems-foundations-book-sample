-- CreateEnum
CREATE TYPE "ArchiveStatus" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Thumbnail" (
    "id" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Thumbnail_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Archive" (
    "id" TEXT NOT NULL,
    "s3Key" TEXT NOT NULL,
    "status" "ArchiveStatus" NOT NULL DEFAULT 'PENDING',
    "size" INTEGER,
    "fileCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,

    CONSTRAINT "Archive_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ArchiveFile" (
    "archiveId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,

    CONSTRAINT "ArchiveFile_pkey" PRIMARY KEY ("archiveId","fileId")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_s3Key_key" ON "UploadedFile"("s3Key");

-- CreateIndex
CREATE UNIQUE INDEX "Thumbnail_fileId_key" ON "Thumbnail"("fileId");

-- CreateIndex
CREATE UNIQUE INDEX "Thumbnail_s3Key_key" ON "Thumbnail"("s3Key");

-- CreateIndex
CREATE UNIQUE INDEX "Archive_s3Key_key" ON "Archive"("s3Key");

-- AddForeignKey
ALTER TABLE "Thumbnail" ADD CONSTRAINT "Thumbnail_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "UploadedFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveFile" ADD CONSTRAINT "ArchiveFile_archiveId_fkey" FOREIGN KEY ("archiveId") REFERENCES "Archive"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ArchiveFile" ADD CONSTRAINT "ArchiveFile_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "UploadedFile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
