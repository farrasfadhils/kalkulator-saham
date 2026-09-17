"use client";

import { ChangeEvent, useRef, useState } from "react";
import { ImageIcon, LoaderCircle, Trash2, UploadCloud } from "lucide-react";

interface ArticleCoverUploaderProps {
  value: string;
  onChange: (path: string) => void;
  onUploaded?: (path: string) => void;
}

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
const TARGET_RATIO = 16 / 9;

function createCanvasBlob(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("Gagal mengompres gambar.")),
      "image/webp",
      quality,
    );
  });
}

async function compressCoverImage(file: File) {
  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () =>
        reject(new Error("File gambar tidak dapat dibuka."));
      element.src = objectUrl;
    });

    const sourceRatio = image.naturalWidth / image.naturalHeight;
    const sourceWidth =
      sourceRatio > TARGET_RATIO
        ? image.naturalHeight * TARGET_RATIO
        : image.naturalWidth;
    const sourceHeight =
      sourceRatio > TARGET_RATIO
        ? image.naturalHeight
        : image.naturalWidth / TARGET_RATIO;
    const sourceX = (image.naturalWidth - sourceWidth) / 2;
    const sourceY = (image.naturalHeight - sourceHeight) / 2;
    const outputWidth = Math.min(1600, Math.round(sourceWidth));
    const outputHeight = Math.round(outputWidth / TARGET_RATIO);
    const canvas = document.createElement("canvas");
    canvas.width = outputWidth;
    canvas.height = outputHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Browser tidak mendukung kompresi gambar.");
    context.drawImage(
      image,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      outputWidth,
      outputHeight,
    );

    let compressed = await createCanvasBlob(canvas, 0.86);
    if (compressed.size > MAX_UPLOAD_BYTES)
      compressed = await createCanvasBlob(canvas, 0.76);
    if (compressed.size > MAX_UPLOAD_BYTES)
      throw new Error(
        "Gambar masih terlalu besar setelah kompresi. Gunakan gambar dengan detail lebih sederhana.",
      );
    return compressed;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export default function ArticleCoverUploader({
  value,
  onChange,
  onUploaded,
}: ArticleCoverUploaderProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/"))
      return setMessage("Pilih file gambar JPG, PNG, atau WebP.");
    if (file.size > MAX_SOURCE_BYTES)
      return setMessage("Ukuran file asli maksimal 12 MB.");

    setUploading(true);
    setMessage(null);
    try {
      const compressed = await compressCoverImage(file);
      const payload = new FormData();
      payload.append(
        "file",
        new File([compressed], "cover.webp", { type: "image/webp" }),
      );
      const response = await fetch("/api/uploads/articles", {
        method: "POST",
        body: payload,
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.error || "Gagal mengunggah gambar.");
      onUploaded?.(data.path);
      onChange(data.path);
      setMessage(
        `Gambar tersimpan dan dikompres ke WebP (${Math.ceil(data.size / 1024)} KB).`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Gagal memproses gambar.",
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={handleFile}
      />
      <button
        type="button"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
        className="flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border-custom bg-sub-slate/60 px-4 text-sm font-semibold text-main transition-colors hover:bg-sub-slate disabled:cursor-wait disabled:opacity-70"
      >
        {uploading ? (
          <LoaderCircle size={17} className="animate-spin text-acc-blue" />
        ) : (
          <UploadCloud size={17} className="text-acc-blue" />
        )}
        {uploading
          ? "Mengompres dan menyimpan gambar..."
          : "Pilih & unggah gambar"}
      </button>
      <p className="text-[11px] leading-4 text-muted">
        JPG, PNG, atau WebP • maks. 12 MB • otomatis dipotong 16:9, maksimal
        1600px, dan disimpan sebagai WebP.
      </p>
      {value && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border-custom bg-sub-slate/50 px-3 py-2">
          <span className="min-w-0 truncate text-[11px] text-muted">
            <ImageIcon size={13} className="mr-1 inline" />
            {value}
          </span>
          <button
            type="button"
            onClick={() => {
              onChange("");
              setMessage(null);
            }}
            className="shrink-0 text-muted hover:text-rose-500"
            title="Lepaskan gambar"
          >
            <Trash2 size={15} />
          </button>
        </div>
      )}
      {message && (
        <p
          className={`text-[11px] leading-4 ${message.includes("tersimpan") ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400"}`}
        >
          {message}
        </p>
      )}
    </div>
  );
}
