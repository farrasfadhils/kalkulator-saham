import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

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

function getCredentials() {
  let cloudName =
    process.env.CLOUDINARY_CLOUD_NAME ||
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
    "";
  let apiKey = process.env.CLOUDINARY_API_KEY || "";
  let apiSecret = process.env.CLOUDINARY_API_SECRET || "";

  if (process.env.CLOUDINARY_URL) {
    try {
      const parsed = new URL(process.env.CLOUDINARY_URL);
      if (parsed.username) apiKey = decodeURIComponent(parsed.username);
      if (parsed.password) apiSecret = decodeURIComponent(parsed.password);
      if (parsed.hostname) cloudName = parsed.hostname;
    } catch {}
  }

  return { cloudName, apiKey, apiSecret };
}

const { cloudName, apiKey, apiSecret } = getCredentials();

if (!cloudName || !apiKey || !apiSecret) {
  throw new Error("Cloudinary credentials are required before migration.");
}
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required before migration.");
}

function signParams(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const toSign =
    sortedKeys
      .map((key) => `${key}=${Array.isArray(params[key]) ? params[key].join(",") : params[key]}`)
      .join("&") + secret;

  return crypto.createHash("sha1").update(toSign).digest("hex");
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
      cloudName || (process.env.CLOUDINARY_URL ? new URL(process.env.CLOUDINARY_URL).hostname : "");
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

async function uploadFile(filePath) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const folder = "hitungsaham/articles";
  const publicId = `migrated-${Date.now()}-${crypto.randomUUID()}`;
  const tags = "hitungsaham,article-media,migrated";
  const overwrite = "false";

  const paramsToSign = {
    folder,
    overwrite,
    public_id: publicId,
    tags,
    timestamp,
  };

  const signature = signParams(paramsToSign, apiSecret);

  const fileBuffer = fs.readFileSync(filePath);
  const formData = new FormData();
  formData.append("file", new Blob([fileBuffer]), path.basename(filePath));
  formData.append("api_key", apiKey);
  formData.append("timestamp", timestamp);
  formData.append("folder", folder);
  formData.append("public_id", publicId);
  formData.append("tags", tags);
  formData.append("overwrite", overwrite);
  formData.append("signature", signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Cloudinary upload failed (${res.status}): ${errorText}`);
  }

  const data = await res.json();
  return {
    public_id: data.public_id,
    secure_url: data.secure_url,
  };
}

async function destroyFile(publicId) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const invalidate = "true";

  const paramsToSign = {
    invalidate,
    public_id: publicId,
    timestamp,
  };

  const signature = signParams(paramsToSign, apiSecret);

  const formData = new FormData();
  formData.append("public_id", publicId);
  formData.append("timestamp", timestamp);
  formData.append("invalidate", invalidate);
  formData.append("api_key", apiKey);
  formData.append("signature", signature);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/destroy`,
    {
      method: "POST",
      body: formData,
    },
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Cloudinary destroy failed (${res.status}): ${errorText}`);
  }

  return res.json();
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
      uploadedIds.map((publicId) => destroyFile(publicId)),
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
