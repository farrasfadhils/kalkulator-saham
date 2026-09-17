import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";

function loadLocalEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...parts] = trimmed.split("=");
    if (!process.env[key.trim()]) {
      process.env[key.trim()] = parts
        .join("=")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }
}

loadLocalEnv();

const cloudName =
  process.env.CLOUDINARY_CLOUD_NAME ||
  process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;
if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
} else {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

if (
  !process.env.CLOUDINARY_URL &&
  (!cloudName ||
    !process.env.CLOUDINARY_API_KEY ||
    !process.env.CLOUDINARY_API_SECRET)
) {
  throw new Error("Cloudinary credentials are required before migration.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required before migration.");
}

const prisma = new PrismaClient();
const uploadsRoot = path.resolve(process.cwd(), "public", "uploads", "articles");
const dryRun = process.argv.includes("--dry-run");

function imageUrls(content, coverImage) {
  const values = new Set();
  if (coverImage?.trim()) values.add(coverImage.trim());
  const markdown = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  const html = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = markdown.exec(content || "")) !== null) values.add(match[1]);
  while ((match = html.exec(content || "")) !== null) values.add(match[1]);
  return [...values];
}

function isManagedUrl(value) {
  try {
    const url = new URL(value);
    const configuredCloudName =
      cloudName || new URL(process.env.CLOUDINARY_URL).hostname;
    const segments = url.pathname.split("/").filter(Boolean);
    const versionIndex = segments.findIndex((segment) => /^v\d+$/.test(segment));
    const publicId =
      versionIndex >= 0 ? segments.slice(versionIndex + 1).join("/") : "";
    return (
      url.protocol === "https:" &&
      url.hostname === "res.cloudinary.com" &&
      url.pathname.startsWith(`/${configuredCloudName}/image/upload/`) &&
      publicId.startsWith("hitungsaham/articles/")
    );
  } catch {
    return false;
  }
}

function localFileFor(value) {
  if (!value.startsWith("/uploads/articles/")) return null;
  const filename = decodeURIComponent(value.slice("/uploads/articles/".length));
  const resolved = path.resolve(uploadsRoot, filename);
  if (!resolved.startsWith(`${uploadsRoot}${path.sep}`)) {
    throw new Error(`Unsafe local media path: ${value}`);
  }
  return resolved;
}

function uploadFile(filePath) {
  return cloudinary.uploader.upload(filePath, {
    resource_type: "image",
    folder: "hitungsaham/articles",
    public_id: `migrated-${Date.now()}-${crypto.randomUUID()}`,
    tags: ["hitungsaham", "article-media", "migrated"],
    overwrite: false,
  });
}

async function main() {
  const articles = await prisma.article.findMany({
    select: { id: true, content: true, coverImage: true },
  });
  const allUrls = new Set(
    articles.flatMap((article) => imageUrls(article.content, article.coverImage)),
  );
  const localUrls = [...allUrls].filter((value) => localFileFor(value));
  const unsupported = [...allUrls].filter(
    (value) => !localFileFor(value) && !isManagedUrl(value),
  );

  if (unsupported.length) {
    throw new Error(
      `Found ${unsupported.length} external/non-Cloudinary article image(s). Re-upload them from the CMS first:\n${unsupported.join("\n")}`,
    );
  }

  for (const value of localUrls) {
    const filePath = localFileFor(value);
    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error(`Local article media is missing: ${value}`);
    }
  }

  console.log(
    `${dryRun ? "Dry run:" : "Migrating"} ${localUrls.length} unique local image(s) across ${articles.length} article(s).`,
  );
  if (dryRun || !localUrls.length) return;

  const replacements = new Map();
  const uploadedIds = [];
  try {
    for (const value of localUrls) {
      const result = await uploadFile(localFileFor(value));
      replacements.set(value, result.secure_url);
      uploadedIds.push(result.public_id);
    }

    await prisma.$transaction(
      articles.map((article) => {
        let content = article.content;
        let coverImage = article.coverImage;
        for (const [before, after] of replacements) {
          content = content.split(before).join(after);
          if (coverImage === before) coverImage = after;
        }
        return prisma.article.update({
          where: { id: article.id },
          data: { content, coverImage },
        });
      }),
    );
  } catch (error) {
    await Promise.allSettled(
      uploadedIds.map((publicId) =>
        cloudinary.uploader.destroy(publicId, {
          resource_type: "image",
          invalidate: true,
        }),
      ),
    );
    throw error;
  }

  for (const value of localUrls) {
    fs.unlinkSync(localFileFor(value));
  }
  console.log(`Migrated and removed ${localUrls.length} local image(s).`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
