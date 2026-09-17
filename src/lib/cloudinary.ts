import { v2 as cloudinary, UploadApiOptions, UploadApiResponse } from "cloudinary";

const CLOUDINARY_HOST = "res.cloudinary.com";
const ARTICLE_MEDIA_FOLDER = "hitungsaham/articles/";

function cloudNameFromUrl() {
  const value = process.env.CLOUDINARY_URL;
  if (!value) return null;
  try {
    return new URL(value).hostname || null;
  } catch {
    return null;
  }
}

export function getCloudinaryCloudName(): string | null {
  return (
    process.env.CLOUDINARY_CLOUD_NAME ||
    process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME ||
    cloudNameFromUrl()
  );
}

const cloudName = getCloudinaryCloudName();

if (process.env.CLOUDINARY_URL) {
  cloudinary.config({ secure: true });
} else if (
  cloudName &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true,
  });
}

export function isCloudinaryConfigured(): boolean {
  return Boolean(
    getCloudinaryCloudName() &&
      (process.env.CLOUDINARY_URL ||
        (process.env.CLOUDINARY_API_KEY &&
          process.env.CLOUDINARY_API_SECRET)),
  );
}

export function assertCloudinaryConfigured() {
  if (!isCloudinaryConfigured()) {
    throw new Error(
      "Cloudinary belum dikonfigurasi. Isi CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, dan CLOUDINARY_API_SECRET.",
    );
  }
}

export interface CloudinaryUploadOptions {
  folder?: string;
  publicId?: string;
  tags?: string[];
  transformation?: UploadApiOptions["transformation"];
}

export async function uploadToCloudinary(
  buffer: Buffer,
  options?: CloudinaryUploadOptions,
): Promise<UploadApiResponse> {
  assertCloudinaryConfigured();

  return new Promise((resolve, reject) => {
    const uploadOptions: UploadApiOptions = {
      resource_type: "image",
      folder: options?.folder || "hitungsaham",
      public_id: options?.publicId,
      tags: options?.tags,
      transformation: options?.transformation,
      overwrite: false,
    };

    const stream = cloudinary.uploader.upload_stream(
      uploadOptions,
      (error, result) => {
        if (error || !result) {
          reject(error || new Error("Gagal mengunggah gambar ke Cloudinary."));
          return;
        }
        resolve(result);
      },
    );

    stream.end(buffer);
  });
}

export type CloudinaryAsset = {
  url: string;
  publicId: string;
};

export function parseCloudinaryAsset(
  value: string | null | undefined,
): CloudinaryAsset | null {
  if (!value || typeof value !== "string") return null;

  try {
    const url = new URL(value);
    const expectedCloudName = getCloudinaryCloudName();
    const segments = url.pathname.split("/").filter(Boolean);

    if (
      url.protocol !== "https:" ||
      url.hostname !== CLOUDINARY_HOST ||
      !expectedCloudName ||
      segments[0] !== expectedCloudName ||
      segments[1] !== "image" ||
      segments[2] !== "upload"
    ) {
      return null;
    }

    // Only parse the path after Cloudinary's version segment. This keeps
    // delivery transformations out of the public_id.
    const versionIndex = segments.findIndex(
      (segment, index) => index >= 3 && /^v\d+$/.test(segment),
    );
    if (versionIndex < 0 || versionIndex === segments.length - 1) return null;

    const publicId = segments
      .slice(versionIndex + 1)
      .map((segment) => decodeURIComponent(segment))
      .join("/")
      .replace(/\.[a-zA-Z0-9]+$/, "");

    return publicId ? { url: value, publicId } : null;
  } catch {
    return null;
  }
}

export function isManagedCloudinaryUrl(value: string): boolean {
  return Boolean(
    parseCloudinaryAsset(value)?.publicId.startsWith(ARTICLE_MEDIA_FOLDER),
  );
}

export function extractArticleImageUrls(
  content?: string | null,
  coverImage?: string | null,
): string[] {
  const urls = new Set<string>();
  if (coverImage?.trim()) urls.add(coverImage.trim());
  if (!content) return Array.from(urls);

  const markdownImage = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g;
  const htmlImage = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = markdownImage.exec(content)) !== null) {
    if (match[1]) urls.add(match[1]);
  }
  while ((match = htmlImage.exec(content)) !== null) {
    if (match[1]) urls.add(match[1]);
  }

  return Array.from(urls);
}

export function extractAllCloudinaryPublicIds(
  content?: string | null,
  coverImage?: string | null,
): string[] {
  const ids = new Set<string>();
  for (const url of extractArticleImageUrls(content, coverImage)) {
    const asset = parseCloudinaryAsset(url);
    if (asset?.publicId.startsWith(ARTICLE_MEDIA_FOLDER)) {
      ids.add(asset.publicId);
    }
  }
  return Array.from(ids);
}

export async function deleteFromCloudinary(publicId: string) {
  assertCloudinaryConfigured();
  if (!publicId) throw new Error("Cloudinary public_id tidak boleh kosong.");
  return cloudinary.uploader.destroy(publicId, {
    resource_type: "image",
    invalidate: true,
  });
}

export async function deleteManyFromCloudinary(publicIds: string[]) {
  const uniqueIds = Array.from(new Set(publicIds.filter(Boolean)));
  return Promise.all(uniqueIds.map((id) => deleteFromCloudinary(id)));
}

export { cloudinary };
