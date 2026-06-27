import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./agent/tauriFs";

export async function setDesktopProjectRoot(path: string): Promise<void> {
  const clean = path.trim();
  if (!clean || !isTauriRuntime()) return;
  await invoke<void>("set_project_root", { path: clean });
}

/**
 * Open the native folder picker and return the chosen directory path, or null
 * if the user cancelled (or if we're not running under the Tauri runtime).
 */
export async function pickProjectFolder(): Promise<string | null> {
  if (!isTauriRuntime()) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const selected = await open({ directory: true, multiple: false, title: "Open Project Folder" });
  if (typeof selected === "string" && selected.trim()) return selected.trim();
  return null;
}

/**
 * Convenience: prompt for a folder and, if chosen, register it as the active
 * desktop project root. Returns the selected path (already set) or null.
 */
export async function chooseAndSetProjectRoot(): Promise<string | null> {
  const picked = await pickProjectFolder();
  if (!picked) return null;
  await setDesktopProjectRoot(picked);
  return picked;
}
