import { useEffect, useState } from "react";
import {
  MAX_ATTACHMENTS,
  imageMediaTypeForFile,
  isImageAttachmentFile,
  normalizeDataUrlMediaType,
  readFileAsDataUrl,
  type Attachment,
} from "./chatAttachments";
import type { ChatLine } from "../../core/store";

interface ChatAttachmentsOptions {
  appendToolLine: (line: ChatLine) => void;
}

export function useChatAttachments({ appendToolLine }: ChatAttachmentsOptions) {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<Attachment | null>(null);

  useEffect(() => {
    if (!previewAttachment) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPreviewAttachment(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [previewAttachment]);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = Array.from(e.target.files ?? []);
    const remaining = MAX_ATTACHMENTS - attachments.length;
    const accepted = picked.slice(0, Math.max(0, remaining));
    const skipped = picked.length - accepted.length;

    if (skipped > 0) {
      appendToolLine({ role: "tool", text: `Attachment limit is ${MAX_ATTACHMENTS}; skipped ${skipped} file${skipped === 1 ? "" : "s"}.` });
    }

    if (accepted.length > 0) {
      const next: Attachment[] = [];
      for (const [index, f] of accepted.entries()) {
        const isImage = isImageAttachmentFile(f);
        const type = isImage ? imageMediaTypeForFile(f) : f.type || "application/octet-stream";
        const base = {
          id: `${Date.now()}-${attachments.length + index}-${f.name}`,
          name: f.name,
          type,
          file: f,
        };
        if (isImage) {
          try {
            next.push({ ...base, dataUrl: normalizeDataUrlMediaType(await readFileAsDataUrl(f), type) });
          } catch (err) {
            appendToolLine({ role: "tool", text: `Attachment failed: ${String(err)}` });
          }
        } else {
          next.push(base);
        }
      }
      if (next.length > 0) {
        setAttachments((items) => [...items, ...next].slice(0, MAX_ATTACHMENTS));
      }
    }
    e.target.value = "";
  }

  function removeAttachment(id: string) {
    setAttachments((items) => items.filter((item) => item.id !== id));
    setPreviewAttachment((item) => (item?.id === id ? null : item));
  }

  function clearAttachments() {
    setAttachments([]);
    setPreviewAttachment(null);
  }

  return {
    attachments,
    setAttachments,
    previewAttachment,
    setPreviewAttachment,
    onPickFile,
    removeAttachment,
    clearAttachments,
  };
}
