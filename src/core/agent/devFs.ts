import type { FsBackend } from "./fsTools";

// In-memory FS for the dev/web build so tools resolve without the Tauri backend.
// Swap for a real invoke()-backed implementation in the Tauri build.
export function createDevFs(seed: Record<string, string> = {}): FsBackend {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    async readFile(path) {
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      return files.get(path)!;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async listDir(prefix) {
      const out = new Set<string>();
      const cleanPrefix = prefix.replace(/\\/g, "/").replace(/^\.\/?$/, "").replace(/\/$/, "");
      const base = cleanPrefix ? `${cleanPrefix}/` : "";
      for (const key of files.keys()) {
        if (cleanPrefix && key !== cleanPrefix && !key.startsWith(base)) continue;
        const rest = key.slice(base.length);
        if (!rest) continue;
        const [name, ...tail] = rest.split("/");
        const child = base ? `${base}${name}` : name;
        out.add(`${tail.length > 0 ? "dir" : "file"} ${child}`);
      }
      return [...out];
    },
  };
}
