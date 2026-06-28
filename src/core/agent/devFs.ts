import type { FsBackend } from "./fsTools";

// In-memory FS for the dev/web build so tools resolve without the Tauri backend.
// Swap for a real invoke()-backed implementation in the Tauri build.
export function createDevFs(seed: Record<string, string> = {}): FsBackend {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  function normalize(path: string) {
    return path.replace(/\\/g, "/").replace(/^\.\/?$/, "").replace(/\/$/, "");
  }
  return {
    async readFile(path) {
      if (!files.has(path)) throw new Error(`No such file: ${path}`);
      return files.get(path)!;
    },
    async writeFile(path, content) {
      files.set(path, content);
    },
    async createDir(path) {
      dirs.add(normalize(path));
    },
    async deletePath(path) {
      const clean = normalize(path);
      files.delete(clean);
      dirs.delete(clean);
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${clean}/`)) files.delete(key);
      }
      for (const key of [...dirs.keys()]) {
        if (key.startsWith(`${clean}/`)) dirs.delete(key);
      }
    },
    async movePath(from, to) {
      const src = normalize(from);
      const dst = normalize(to);
      if (files.has(src)) {
        files.set(dst, files.get(src)!);
        files.delete(src);
        return;
      }
      if (!dirs.has(src) && ![...files.keys()].some((key) => key.startsWith(`${src}/`))) {
        throw new Error(`No such file or directory: ${src}`);
      }
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${src}/`)) {
          files.set(`${dst}/${key.slice(src.length + 1)}`, files.get(key)!);
          files.delete(key);
        }
      }
      for (const key of [...dirs.keys()]) {
        if (key === src || key.startsWith(`${src}/`)) {
          dirs.add(key === src ? dst : `${dst}/${key.slice(src.length + 1)}`);
          dirs.delete(key);
        }
      }
    },
    async listDir(prefix) {
      const out = new Set<string>();
      const cleanPrefix = normalize(prefix);
      const base = cleanPrefix ? `${cleanPrefix}/` : "";
      for (const key of dirs) {
        if (cleanPrefix && key !== cleanPrefix && !key.startsWith(base)) continue;
        const rest = key.slice(base.length);
        if (!rest) continue;
        const [name] = rest.split("/");
        const child = base ? `${base}${name}` : name;
        out.add(`dir ${child}`);
      }
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
