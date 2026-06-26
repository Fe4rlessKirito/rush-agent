import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type UpdateCheckResult =
  | { status: "current"; message: string }
  | { status: "available"; message: string; version: string }
  | { status: "installed"; message: string; version: string }
  | { status: "error"; message: string };

function errorMessage(err: unknown) {
  return err instanceof Error ? err.message : String(err);
}

export async function checkForUpdates(install: boolean): Promise<UpdateCheckResult> {
  try {
    const update = await check({ timeout: 15000 });

    if (!update) {
      return { status: "current", message: "Rush is up to date." };
    }

    if (!install) {
      return {
        status: "available",
        version: update.version,
        message: `Version ${update.version} is available.`,
      };
    }

    await update.downloadAndInstall();
    await relaunch();

    return {
      status: "installed",
      version: update.version,
      message: `Version ${update.version} was installed. Relaunching Rush.`,
    };
  } catch (err) {
    return {
      status: "error",
      message: `Update check failed: ${errorMessage(err)}`,
    };
  }
}
