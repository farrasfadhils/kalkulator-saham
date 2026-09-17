CREATE TABLE "CloudinaryDeletionJob" (
    "id" TEXT NOT NULL,
    "publicId" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CloudinaryDeletionJob_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CloudinaryDeletionJob_publicId_key"
ON "CloudinaryDeletionJob"("publicId");
