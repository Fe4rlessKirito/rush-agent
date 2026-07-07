import type { ConfirmRequest } from "../../core/agent/tools";

interface ConfirmActionModalProps {
  request: ConfirmRequest;
  resolve: (ok: boolean) => void;
}

export function ConfirmActionModal({ request, resolve }: ConfirmActionModalProps) {
  return (
    <div className="confirm-overlay" role="dialog" aria-modal="true">
      <div className="confirm-modal">
        <div className="confirm-title">Confirm action</div>
        <p className="confirm-summary">{request.summary}</p>
        <div className="confirm-tool">
          <code>{request.tool}</code>
        </div>
        <div className="confirm-actions">
          <button className="confirm-deny" onClick={() => resolve(false)}>
            Deny
          </button>
          <button className="confirm-allow" onClick={() => resolve(true)}>
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
