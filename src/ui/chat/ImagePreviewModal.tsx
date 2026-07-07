import type { Attachment } from "./chatAttachments";

interface ImagePreviewModalProps {
  attachment: Attachment;
  close: () => void;
}

export function ImagePreviewModal({ attachment, close }: ImagePreviewModalProps) {
  if (!attachment.dataUrl) return null;
  return (
    <div className="image-preview-overlay" role="dialog" aria-modal="true" onMouseDown={close}>
      <div className="image-preview-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="image-preview-head">
          <span>{attachment.name}</span>
          <button type="button" onClick={close} aria-label="Close image preview">
            x
          </button>
        </div>
        <img src={attachment.dataUrl} alt={attachment.name} />
      </div>
    </div>
  );
}
