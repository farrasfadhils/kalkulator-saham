import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { verifySession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import {
  assertCloudinaryConfigured,
  parseCloudinaryAsset,
  uploadToCloudinary,
} from "@/lib/cloudinary";
import { flushArticleMediaCleanup } from "@/lib/article-media-cleanup";

export const runtime = "nodejs";

const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

function isWebp(buffer: Buffer) {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

export async function POST(request: NextRequest) {
  const session = await verifySession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    assertCloudinaryConfigured();
    await flushArticleMediaCleanup().catch((error) =>
      console.error("Cloudinary cleanup retry failed:", error),
    );

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File))
      return NextResponse.json(
        { error: "File gambar wajib dipilih." },
        { status: 400 },
      );
    if (file.type !== "image/webp")
      return NextResponse.json(
        { error: "Gambar harus dikompres ke format WebP." },
        { status: 400 },
      );
    if (file.size === 0 || file.size > MAX_UPLOAD_BYTES)
      return NextResponse.json(
        { error: "Ukuran gambar maksimal 2 MB setelah kompresi." },
        { status: 400 },
      );

    const buffer = Buffer.from(await file.arrayBuffer());
    if (!isWebp(buffer))
      return NextResponse.json(
        { error: "Format file gambar tidak valid." },
        { status: 400 },
      );

    const uploadResult = await uploadToCloudinary(buffer, {
      folder: "hitungsaham/articles",
      publicId: `${Date.now()}-${randomUUID()}`,
      tags: ["hitungsaham", "article-media"],
    });

    return NextResponse.json({
      path: uploadResult.secure_url,
      publicId: uploadResult.public_id,
      size: uploadResult.bytes || buffer.length,
    });
  } catch (error) {
    console.error("Article image upload failed:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Gagal menyimpan gambar ke Cloudinary.",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const session = await verifySession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await request.json()) as { urls?: unknown };
    const urls = Array.isArray(body.urls)
      ? body.urls.filter((value): value is string => typeof value === "string")
      : [];
    if (!urls.length || urls.length > 100) {
      return NextResponse.json(
        { error: "Daftar media tidak valid." },
        { status: 400 },
      );
    }

    const publicIds = Array.from(
      new Set(
        urls
          .map((url) => parseCloudinaryAsset(url)?.publicId)
          .filter(
            (publicId): publicId is string =>
              Boolean(publicId?.startsWith("hitungsaham/articles/")),
          ),
      ),
    );
    if (!publicIds.length) {
      return NextResponse.json({ success: true, mediaCleanup: { deleted: 0, pending: 0 } });
    }

    await prisma.cloudinaryDeletionJob.createMany({
      data: publicIds.map((publicId) => ({ publicId })),
      skipDuplicates: true,
    });
    const mediaCleanup = await flushArticleMediaCleanup().catch((error) => {
      console.error("Cloudinary cleanup failed after orphan queueing:", error);
      return { deleted: 0, pending: null };
    });
    return NextResponse.json({ success: true, mediaCleanup });
  } catch (error) {
    console.error("Article upload cleanup failed:", error);
    return NextResponse.json(
      { error: "Gagal membersihkan media artikel." },
      { status: 500 },
    );
  }
}
