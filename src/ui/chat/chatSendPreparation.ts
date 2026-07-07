import type { ChatLine } from "../../core/store";
import type { ChatContentPart, ChatMessage } from "../../core/providers/types";
import type { Attachment } from "./chatAttachments";

export interface LibraryContextSummaryItem {
  kind: "chat" | "research";
  title: string;
}

export function splitAttachments(attachments: Attachment[]) {
  const imageAttachments = attachments.filter((item) => item.dataUrl);
  const fileAttachments = attachments.filter((item) => !item.dataUrl);
  return {
    imageAttachments,
    fileAttachments,
    hasImages: imageAttachments.length > 0,
    hasFiles: fileAttachments.length > 0,
  };
}

export function buildImagePrompt({
  modelUserText,
  imageAttachments,
}: {
  modelUserText: string;
  imageAttachments: Attachment[];
}): string {
  if (imageAttachments.length === 0) return "";
  return [
    modelUserText.trim() ||
      `What do you see in the attached ${imageAttachments.length === 1 ? "image" : "images"} ${imageAttachments.map((item) => item.name).join(", ")}?`,
    "",
    `Attached ${imageAttachments.length === 1 ? "image" : "images"}: ${imageAttachments.map((item) => item.name).join(", ")}.`,
    "Analyze the image content itself. This is not filesystem, terminal, or screen access.",
  ].join("\n");
}

export function buildUserContent({
  hasImages,
  imagePrompt,
  imageAttachments,
  modelUserText,
}: {
  hasImages: boolean;
  imagePrompt: string;
  imageAttachments: Attachment[];
  modelUserText: string;
}): string | ChatContentPart[] {
  return hasImages
    ? [
        { type: "text", text: imagePrompt },
        ...imageAttachments.map((item) => ({
          type: "image" as const,
          dataUrl: item.dataUrl ?? "",
          mediaType: item.type,
          name: item.name,
        })),
      ]
    : modelUserText;
}

export function fallbackChatHistory(chat: ChatLine[]): ChatMessage[] {
  return chat
    .filter((line) => line.role === "user" || line.role === "agent")
    .filter((line) => line.text.trim())
    .map((line) => ({
      role: line.role === "user" ? "user" : "assistant",
      content: line.text,
    }));
}

export function attachmentUnsupportedMessage({
  hasImages,
  hasFiles,
  supportsImageChatEndpoint,
  supportsFileChatEndpoint,
  supportsNativeImages,
}: {
  hasImages: boolean;
  hasFiles: boolean;
  supportsImageChatEndpoint?: boolean;
  supportsFileChatEndpoint?: boolean;
  supportsNativeImages: boolean;
}): string | null {
  const imageUnsupported = hasImages && !supportsImageChatEndpoint && !supportsNativeImages;
  const fileUnsupported = hasFiles && !supportsFileChatEndpoint;
  const mixedUnsupported = hasImages && hasFiles && !supportsImageChatEndpoint;
  if (!imageUnsupported && !fileUnsupported && !mixedUnsupported) return null;
  return imageUnsupported
    ? "This provider is not configured for image attachments. Enable Provider Settings -> Image endpoint for WMan-compatible proxies, or choose a provider that supports image content."
    : fileUnsupported
      ? "This provider is not configured for file attachments. Enable Provider Settings -> File endpoint for WMan-compatible proxies, or choose a provider that supports file uploads."
      : "Mixed image and file attachments need both Provider Settings -> Image endpoint and File endpoint enabled for this provider.";
}

export function buildVisibleUserText({
  userText,
  hasImages,
  hasFiles,
  imageAttachments,
  fileAttachments,
  hasSelectedLibraryContext,
  contextItems,
}: {
  userText: string;
  hasImages: boolean;
  hasFiles: boolean;
  imageAttachments: Attachment[];
  fileAttachments: Attachment[];
  hasSelectedLibraryContext: boolean;
  contextItems: LibraryContextSummaryItem[];
}): string {
  const attachmentSummary = [
    hasImages
      ? `[attached ${imageAttachments.length === 1 ? "image" : "images"}: ${imageAttachments.map((item) => item.name).join(", ")}]`
      : "",
    hasFiles
      ? `[attached ${fileAttachments.length === 1 ? "file" : "files"}: ${fileAttachments.map((item) => item.name).join(", ")}]`
      : "",
    hasSelectedLibraryContext ? `[attached Library context: ${contextItems.map((item) => `${item.kind === "chat" ? "Chat" : "Research"}: ${item.title}`).join(", ")}]` : "",
  ].filter(Boolean).join("\n");
  const fallbackUserText = hasSelectedLibraryContext ? "Use selected Library context." : "Analyze the attachment(s)";
  return attachmentSummary
    ? `${userText || fallbackUserText}\n${attachmentSummary}`
    : userText;
}

export function flowPromptForTurn({
  userText,
  hasSelectedLibraryContext,
  contextItems,
}: {
  userText: string;
  hasSelectedLibraryContext: boolean;
  contextItems: LibraryContextSummaryItem[];
}): string {
  return userText.trim() || (
    hasSelectedLibraryContext
      ? `Use selected Library context: ${contextItems.map((item) => item.title).join(", ")}`
      : userText
  );
}
