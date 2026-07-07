import type { Attachment } from "./chatAttachments";
import {
  streamImageEndpointAttachments,
  type ProviderEndpointConfig,
  uploadFileEndpointAttachments,
} from "./attachmentEndpointChat";

interface AttachmentSendRuntimeOptions {
  cfg: ProviderEndpointConfig;
  imageAttachments: Attachment[];
  fileAttachments: Attachment[];
  hasImages: boolean;
  hasFiles: boolean;
  supportsImageChatEndpoint?: boolean;
  supportsFileChatEndpoint?: boolean;
  question: string;
  model: string | null;
  signal?: AbortSignal;
  appendText: (text: string) => void;
  appendError: (text: string) => void;
  afterDelta?: () => Promise<void>;
}

export async function runAttachmentSendRuntime({
  cfg,
  imageAttachments,
  fileAttachments,
  hasImages,
  hasFiles,
  supportsImageChatEndpoint,
  supportsFileChatEndpoint,
  question,
  model,
  signal,
  appendText,
  appendError,
  afterDelta,
}: AttachmentSendRuntimeOptions): Promise<string> {
  let assistantText = "";
  try {
    if (hasImages && supportsImageChatEndpoint) {
      const text = await streamImageEndpointAttachments({
        cfg,
        imageAttachments,
        question,
        model,
        signal,
        appendText,
        afterDelta,
      });
      assistantText += text;
      if (hasFiles && supportsFileChatEndpoint) {
        const fileText = await uploadFileEndpointAttachments({
          cfg,
          fileAttachments,
          question,
          model,
          signal,
          appendText,
        });
        assistantText += fileText;
      }
    } else if (hasFiles && supportsFileChatEndpoint) {
      const text = await uploadFileEndpointAttachments({
        cfg,
        fileAttachments,
        question,
        model,
        signal,
        appendText,
      });
      assistantText += text;
    }
  } catch (err) {
    appendError(`Error: ${String(err)}`);
  }
  return assistantText;
}
