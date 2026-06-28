import { useEffect } from "react";
import { useNotificationStore, type AppNotification } from "../../core/notificationStore";

function ToastIcon({ tone }: { tone: AppNotification["tone"] }) {
  const common = {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  } as const;

  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {tone === "success" && (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="m8 12 2.5 2.5L16 9" />
        </>
      )}
      {tone === "warning" && (
        <>
          <path {...common} d="M12 3 2.8 20h18.4L12 3Z" />
          <path {...common} d="M12 9v5" />
          <path {...common} d="M12 17h.01" />
        </>
      )}
      {tone === "error" && (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="m9 9 6 6" />
          <path {...common} d="m15 9-6 6" />
        </>
      )}
      {tone === "info" && (
        <>
          <circle {...common} cx="12" cy="12" r="9" />
          <path {...common} d="M12 11v5" />
          <path {...common} d="M12 8h.01" />
        </>
      )}
    </svg>
  );
}

function ToastItem({ notification }: { notification: AppNotification }) {
  const dismiss = useNotificationStore((s) => s.dismiss);

  useEffect(() => {
    if (notification.durationMs <= 0) return;
    const timer = window.setTimeout(() => dismiss(notification.id), notification.durationMs);
    return () => window.clearTimeout(timer);
  }, [dismiss, notification.durationMs, notification.id]);

  return (
    <div className={`app-toast ${notification.tone}`} role="status">
      <span className="app-toast-icon">
        <ToastIcon tone={notification.tone} />
      </span>
      <div>
        <strong>{notification.title}</strong>
        {notification.message && <span>{notification.message}</span>}
      </div>
      <button
        className="app-toast-close"
        onClick={() => dismiss(notification.id)}
        aria-label="Dismiss notification"
      >
        x
      </button>
    </div>
  );
}

export function ToastHost() {
  const notifications = useNotificationStore((s) => s.notifications);
  if (notifications.length === 0) return null;

  return (
    <div className="app-toast-host" aria-live="polite" aria-relevant="additions">
      {notifications.map((notification) => (
        <ToastItem key={notification.id} notification={notification} />
      ))}
    </div>
  );
}
