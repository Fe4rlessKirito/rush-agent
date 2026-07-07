import { useEffect } from "react";
import type { ConfirmRequest } from "../../core/agent/tools";
import type { useAppStore } from "../../core/store";
import { chatTools, codeTools, flowTools } from "./chatToolRegistries";

type ToolPermissions = ReturnType<typeof useAppStore.getState>["toolPermissions"];

interface ChatToolPermissionsOptions {
  toolPermissions: ToolPermissions;
  requestConfirm: (request: ConfirmRequest, resolve: (ok: boolean) => void) => void;
}

export function useChatToolPermissions({
  toolPermissions,
  requestConfirm,
}: ChatToolPermissionsOptions) {
  useEffect(() => {
    const confirmer = (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => {
        requestConfirm(req, resolve);
      });
    codeTools.setConfirmer(confirmer);
    chatTools.setConfirmer(confirmer);
    flowTools.setConfirmer(confirmer);
    return () => {
      codeTools.setConfirmer(null);
      chatTools.setConfirmer(null);
      flowTools.setConfirmer(null);
    };
  }, [requestConfirm]);

  useEffect(() => {
    codeTools.setPermissionRules(toolPermissions);
    chatTools.setPermissionRules(toolPermissions);
    flowTools.setPermissionRules(toolPermissions);
  }, [toolPermissions]);
}
