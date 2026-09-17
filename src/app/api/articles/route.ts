import { revalidateTag } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifySession } from "@/lib/auth";
import {
  extractArticleImageUrls,
  extractAllCloudinaryPublicIds,
  isManagedCloudinaryUrl,
} from "@/lib/cloudinary";
import { flushArticleMediaCleanup } from "@/lib/article-media-cleanup";

const ARTICLE_TYPES = new Set(["ARTICLE", "BLOG"]);
const ARTICLE_STATUSES = new Set(["DRAFT", "PUBLISHED"]);
const MAX_TRADER_PICKS = 3;

type ArticleInput = {
  title: string;
  slug: string;
  category: string;
  type: "ARTICLE" | "BLOG";
  status: "DRAFT" | "PUBLISHED";
  excerpt: string;
  content: string;
  coverImage: string | null;
  author: string;
  isTraderPick: boolean;
};

function cleanSlug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function parseArticleInput(body: Record<string, unknown>): {
  data?: ArticleInput;
  error?: string;
} {
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const slug = cleanSlug(typeof body.slug === "string" ? body.slug : title);
  const category =
    typeof body.category === "string" ? body.category.trim() : "";
  const excerpt = typeof body.excerpt === "string" ? body.excerpt.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  const author =
    typeof body.author === "string" && body.author.trim()
      ? body.author.trim()
      : "Tim Redaksi";
  const type =
    typeof body.type === "string" && ARTICLE_TYPES.has(body.type)
      ? body.type
      : "BLOG";
  const status =
    typeof body.status === "string" && ARTICLE_STATUSES.has(body.status)
      ? body.status
      : "DRAFT";
  const rawCover =
    typeof body.coverImage === "string" ? body.coverImage.trim() : "";
  const isTraderPick = body.isTraderPick === true;

  if (!title || !slug || !category || !excerpt || !content) {
    return {
      error: "Judul, slug, kategori, ringkasan, dan isi artikel wajib diisi.",
    };
  }
  if (
    title.length > 160 ||
    slug.length > 180 ||
    category.length > 100 ||
    author.length > 100
  ) {
    return {
      error: "Judul, slug, kategori, atau nama penulis terlalu panjang.",
    };
  }
  if (excerpt.length < 30 || excerpt.length > 320) {
    return { error: "Ringkasan harus berisi 30–320 karakter." };
  }
  if (content.length < 50 || content.length > 200_000) {
    return { error: "Isi artikel harus berisi minimal 50 karakter." };
  }
  const invalidImageUrls = extractArticleImageUrls(content, rawCover).filter(
    (url) => !isManagedCloudinaryUrl(url),
  );
  if (invalidImageUrls.length > 0) {
    return {
      error:
        "Semua gambar artikel wajib berasal dari akun Cloudinary yang dikonfigurasi. Unggah ulang gambar lokal atau eksternal melalui tombol Upload Gambar.",
    };
  }
  if (rawCover.length > 2048)
    return { error: "URL gambar sampul terlalu panjang." };

  return {
    data: {
      title,
      slug,
      category,
      type: type as ArticleInput["type"],
      status: status as ArticleInput["status"],
      excerpt,
      content,
      coverImage: rawCover || null,
      author,
      isTraderPick,
    },
  };
}

async function validateTraderPickLimit(
  isTraderPick: boolean,
  currentArticleId?: string,
): Promise<string | null> {
  if (!isTraderPick) return null;
  const count = await prisma.article.count({
    where: {
      isTraderPick: true,
      ...(currentArticleId ? { id: { not: currentArticleId } } : {}),
    },
  });
  return count >= MAX_TRADER_PICKS
    ? `Catatan Pilihan Trader dibatasi maksimal ${MAX_TRADER_PICKS} artikel. Hapus pilihan dari artikel lain terlebih dahulu.`
    : null;
}

function databaseErrorResponse(error: unknown) {
  const code =
    typeof error === "object" && error && "code" in error
      ? String(error.code)
      : "";
  if (code === "P2002") {
    return NextResponse.json(
      { error: "Slug sudah digunakan artikel lain." },
      { status: 409 },
    );
  }
  return NextResponse.json(
    { error: "Terjadi kesalahan saat memproses artikel." },
    { status: 500 },
  );
}

export async function GET(req: NextRequest) {
  const session = await verifySession();
  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  const type = searchParams.get("type");

  try {
    if (session) {
      await flushArticleMediaCleanup().catch((error) =>
        console.error("Cloudinary cleanup retry failed:", error),
      );
    }
    if (id) {
      if (!session)
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      const article = await prisma.article.findUnique({ where: { id } });
      if (!article)
        return NextResponse.json(
          { error: "Artikel tidak ditemukan." },
          { status: 404 },
        );
      return NextResponse.json({ article });
    }

    const articles = await prisma.article.findMany({
      where: {
        ...(!session ? { status: "PUBLISHED" as const } : {}),
        ...(type && ARTICLE_TYPES.has(type) ? { type } : {}),
      },
      orderBy: [{ publishedAt: "desc" }, { updatedAt: "desc" }],
    });
    return NextResponse.json({ articles });
  } catch (error) {
    return databaseErrorResponse(error);
  }
}

export async function POST(req: NextRequest) {
  const session = await verifySession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const parsed = parseArticleInput(await req.json());
    if (!parsed.data)
      return NextResponse.json({ error: parsed.error }, { status: 400 });

    const traderPickError = await validateTraderPickLimit(
      parsed.data.isTraderPick,
    );
    if (traderPickError)
      return NextResponse.json({ error: traderPickError }, { status: 400 });

    const category = await prisma.category.findUnique({
      where: { name: parsed.data.category },
    });
    if (!category)
      return NextResponse.json(
        { error: "Kategori artikel tidak valid." },
        { status: 400 },
      );

    const article = await prisma.article.create({
      data: {
        ...parsed.data,
        source: "HitungSaham",
        publishedAt: new Date(),
      },
    });
    try {
      revalidateTag("articles", "max");
    } catch {}
    return NextResponse.json({ success: true, article }, { status: 201 });
  } catch (error) {
    return databaseErrorResponse(error);
  }
}

export async function PUT(req: NextRequest) {
  const session = await verifySession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    if (!id)
      return NextResponse.json(
        { error: "ID artikel tidak valid." },
        { status: 400 },
      );

    const parsed = parseArticleInput(body);
    if (!parsed.data)
      return NextResponse.json({ error: parsed.error }, { status: 400 });
    const articleData = parsed.data;

    const [existing, category] = await Promise.all([
      prisma.article.findUnique({ where: { id } }),
      prisma.category.findUnique({ where: { name: articleData.category } }),
    ]);
    if (!existing)
      return NextResponse.json(
        { error: "Artikel tidak ditemukan." },
        { status: 404 },
      );
    if (!category)
      return NextResponse.json(
        { error: "Kategori artikel tidak valid." },
        { status: 400 },
      );

    const traderPickError = await validateTraderPickLimit(
      articleData.isTraderPick,
      existing.id,
    );
    if (traderPickError)
      return NextResponse.json({ error: traderPickError }, { status: 400 });

    const oldIds = extractAllCloudinaryPublicIds(
      existing.content,
      existing.coverImage,
    );
    const newIds = new Set(
      extractAllCloudinaryPublicIds(
        articleData.content,
        articleData.coverImage,
      ),
    );
    const removedIds = oldIds.filter((publicId) => !newIds.has(publicId));

    const article = await prisma.$transaction(async (tx) => {
      const updated = await tx.article.update({
        where: { id },
        data: {
          ...articleData,
          publishedAt:
            existing.status === "DRAFT" && articleData.status === "PUBLISHED"
              ? new Date()
              : existing.publishedAt,
        },
      });
      if (removedIds.length > 0) {
        await tx.cloudinaryDeletionJob.createMany({
          data: removedIds.map((publicId) => ({ publicId })),
          skipDuplicates: true,
        });
      }
      return updated;
    });
    const mediaCleanup = await flushArticleMediaCleanup().catch((error) => {
      console.error("Cloudinary cleanup failed after article update:", error);
      return { deleted: 0, pending: null };
    });
    try {
      revalidateTag("articles", "max");
      revalidateTag(`article-${existing.slug}`, "max");
      if (existing.slug !== article.slug)
        revalidateTag(`article-${article.slug}`, "max");
    } catch {}
    return NextResponse.json({ success: true, article, mediaCleanup });
  } catch (error) {
    return databaseErrorResponse(error);
  }
}

export async function DELETE(req: NextRequest) {
  const session = await verifySession();
  if (!session)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id)
    return NextResponse.json(
      { error: "ID artikel tidak valid." },
      { status: 400 },
    );

  try {
    const existing = await prisma.article.findUnique({ where: { id } });
    if (!existing) {
      return NextResponse.json(
        { error: "Artikel tidak ditemukan." },
        { status: 404 },
      );
    }

    const cloudinaryIds = extractAllCloudinaryPublicIds(
      existing.content,
      existing.coverImage,
    );

    const article = await prisma.$transaction(async (tx) => {
      const deleted = await tx.article.delete({ where: { id } });
      if (cloudinaryIds.length > 0) {
        await tx.cloudinaryDeletionJob.createMany({
          data: cloudinaryIds.map((publicId) => ({ publicId })),
          skipDuplicates: true,
        });
      }
      return deleted;
    });
    const mediaCleanup = await flushArticleMediaCleanup().catch((error) => {
      console.error("Cloudinary cleanup failed after article deletion:", error);
      return { deleted: 0, pending: null };
    });
    try {
      revalidateTag("articles", "max");
      revalidateTag(`article-${article.slug}`, "max");
    } catch {}
    return NextResponse.json({ success: true, mediaCleanup });
  } catch (error) {
    return databaseErrorResponse(error);
  }
}
