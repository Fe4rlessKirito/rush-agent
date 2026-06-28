import { invoke } from "@tauri-apps/api/core";
import type { FsBackend } from "./fsTools";

interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export function isTauriRuntime(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function createTauriFs(): FsBackend {
  return {
    readFile(path) {
      return invoke<string>("read_file", { path });
    },
    writeFile(path, content) {
      return invoke<void>("write_file", { path, content });
    },
    createDir(path) {
      return invoke<void>("create_dir", { path });
    },
    deletePath(path) {
      return invoke<void>("delete_file", { path });
    },
    movePath(from, to) {
      return invoke<void>("move_file", { from, to });
    },
    async listDir(path) {
      const entries = await invoke<DirEntry[]>("list_dir", { path });
      return entries.map((entry) => `${entry.is_dir ? "dir " : "file"} ${entry.path}`);
    },
  };
}
