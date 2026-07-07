export interface Attachment {
  id: string;
  name: string;
  type: string;
  file: File;
  dataUrl?: string;
}

export const MAX_ATTACHMENTS = 12;

const IMAGE_EXTENSIONS = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "webp"]);
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export function extensionOf(filename: string): string {
  return filename.includes(".") ? filename.split(".").pop()?.toLowerCase() ?? "" : "";
}

export function isImageAttachmentFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_EXTENSIONS.has(extensionOf(file.name));
}

export function imageMediaTypeForFile(file: File): string {
  if (file.type.startsWith("image/")) return file.type;
  return IMAGE_MEDIA_TYPES[extensionOf(file.name)] ?? "image/png";
}

export function normalizeDataUrlMediaType(dataUrl: string, mediaType: string): string {
  if (!dataUrl.startsWith("data:") || !dataUrl.includes(",")) return dataUrl;
  return dataUrl.replace(/^data:[^,]*,/, `data:${mediaType};base64,`);
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}
