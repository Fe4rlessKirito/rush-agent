import { useEffect, useState } from "react";
import { useAppStore } from "../../core/store";
import { modeSwitchResult, presetFromPermissions } from "./chatPanelHelpers";
import { setModeSwitchHandler } from "./chatToolRegistries";

export interface PendingModeSwitch {
  mode: "plain" | "agent";
  reason: string;
  resolve: (ok: boolean) => void;
}

interface ModeSwitchPromptOptions {
  activeConversationId: string | null;
  effectiveMode: "plain" | "agent" | "flow";
  onReset: () => void;
}

export function useModeSwitchPrompt({
  activeConversationId,
  effectiveMode,
  onReset,
}: ModeSwitchPromptOptions) {
  const [pendingModeSwitch, setPendingModeSwitch] = useState<PendingModeSwitch | null>(null);

  useEffect(() => {
    setModeSwitchHandler((mode, reason) => {
      if (mode === "agent" && presetFromPermissions(useAppStore.getState().toolPermissions).id === "full") {
        useAppStore.getState().setChatMode("agent");
        return Promise.resolve(modeSwitchResult(mode, "auto"));
      }
      return new Promise<string>((resolve) => {
        setPendingModeSwitch({
          mode,
          reason,
          resolve: (ok) => {
            if (ok) {
              useAppStore.getState().setChatMode(mode);
              resolve(modeSwitchResult(mode, "approved"));
            } else {
              resolve(modeSwitchResult(mode, "dismissed"));
            }
          },
        });
      });
    });
    return () => {
      setModeSwitchHandler(null);
    };
  }, []);

  useEffect(() => {
    onReset();
    setPendingModeSwitch((pending) => {
      pending?.resolve(false);
      return null;
    });
  }, [activeConversationId, effectiveMode, onReset]);

  function resolveModeSwitch(ok: boolean) {
    setPendingModeSwitch((pending) => {
      pending?.resolve(ok);
      return null;
    });
  }

  return { pendingModeSwitch, resolveModeSwitch };
}
