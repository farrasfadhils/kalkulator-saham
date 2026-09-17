import { prisma } from "@/lib/db";
import {
  deleteFromCloudinary,
  extractAllCloudinaryPublicIds,
} from "@/lib/cloudinary";

const CLEANUP_BATCH_SIZE = 50;

function errorMessage(error: unknown) {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 1000);
}

/**
 * Process durable deletion jobs. Every asset is checked against all remaining
 * articles first, so a shared image is never deleted while still referenced.
 * Failed jobs remain in the database and are retried by the next mutation.
 */
export async function flushArticleMediaCleanup() {
  const jobs = await prisma.cloudinaryDeletionJob.findMany({
    orderBy: { createdAt: "asc" },
    take: CLEANUP_BATCH_SIZE,
  });
  if (!jobs.length) return { deleted: 0, pending: 0 };

  const articles = await prisma.article.findMany({
    select: { content: true, coverImage: true },
  });
  const referencedIds = new Set(
    articles.flatMap((article) =>
      extractAllCloudinaryPublicIds(article.content, article.coverImage),
    ),
  );

  let deleted = 0;
  for (const job of jobs) {
    if (referencedIds.has(job.publicId)) {
      await prisma.cloudinaryDeletionJob.deleteMany({ where: { id: job.id } });
      continue;
    }

    try {
      await deleteFromCloudinary(job.publicId);
      await prisma.cloudinaryDeletionJob.deleteMany({ where: { id: job.id } });
      deleted += 1;
    } catch (error) {
      await prisma.cloudinaryDeletionJob.updateMany({
        where: { id: job.id },
        data: {
          attempts: { increment: 1 },
          lastError: errorMessage(error),
        },
      });
    }
  }

  return {
    deleted,
    pending: await prisma.cloudinaryDeletionJob.count(),
  };
}
