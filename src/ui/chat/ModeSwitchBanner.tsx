interface ModeSwitchBannerProps {
  mode: "plain" | "agent";
  reason: string;
  resolve: (ok: boolean) => void;
}

export function ModeSwitchBanner({ mode, reason, resolve }: ModeSwitchBannerProps) {
  return (
    <div className="mode-switch-banner" role="alert">
      <span>
        Rush suggests switching to <strong>{mode === "agent" ? "Code" : "Chat"}</strong> mode
        {reason ? `: ${reason}` : "."}
      </span>
      <div className="mode-switch-banner-actions">
        <button
          type="button"
          onClick={() => resolve(true)}
        >
          Switch
        </button>
        <button type="button" onClick={() => resolve(false)}>
          Dismiss
        </button>
      </div>
    </div>
  );
}
