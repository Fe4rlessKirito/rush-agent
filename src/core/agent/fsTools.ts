import type { Tool } from "./tools";

// Built-in filesystem tools. These are thin wrappers over an FsBackend; in the
// Tauri build the actual fs access goes through invoke() to the Rust backend
// (sandboxed to the open workspace). The web/dev build stubs them with an
// in-memory FS. The point is the SHAPE — it matches the MCP tool contract
// exactly, so built-ins and remote MCP tools live side by side in one registry.
//
// Tool descriptions here are behavior contracts: they tell the model WHEN and
// WHEN NOT to reach for each tool, not just what it does. That guidance is the
// single biggest lever on tool-selection quality, so it lives with the tool.

export interface FsBackend {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<string[]>;
  createDir?(path: string): Promise<void>;
  deletePath?(path: string): Promise<void>;
  movePath?(from: string, to: string): Promise<void>;
}

// Tracks which files have been read this session. edit_file requires a prior
// read so the model never edits a file blind — the read-before-edit invariant.
const readPaths = new Set<string>();

function normalizePath(path: string): string {
  const clean = String(path || ".")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  return clean === "." ? "" : clean;
}

function joinPath(parent: string, child: string): string {
  const cleanParent = normalizePath(parent);
  const cleanChild = normalizePath(child);
  return cleanParent ? `${cleanParent}/${cleanChild}` : cleanChild;
}

function pathArg(args: Record<string, unknown>, fallback = ""): string {
  return normalizePath(String(args.file_path ?? args.path ?? fallback));
}

function listDirPathArg(args: Record<string, unknown>, fallback = "."): string {
  const raw = String(args.file_path ?? args.path ?? fallback).trim();
  if (!raw) return "";
  const forward = raw.replace(/\\/g, "/");
  const isAbsolute =
    /^[A-Za-z]:\//.test(forward) ||
    forward.startsWith("/") ||
    forward.startsWith("//");
  if (!isAbsolute) return normalizePath(forward);
  if (/^[A-Za-z]:\/?$/.test(forward)) return forward.endsWith("/") ? forward : `${forward}/`;
  return forward.length > 1 ? forward.replace(/\/$/, "") : forward;
}

function readKey(path: string): string {
  return normalizePath(path);
}

interface ListedEntry {
  path: string;
  isDir: boolean | null;
}

function parseListedEntry(raw: string, parent: string): ListedEntry {
  if (raw.startsWith("dir ")) return { path: normalizePath(raw.slice(4)), isDir: true };
  if (raw.startsWith("file ")) return { path: normalizePath(raw.slice(5)), isDir: false };
  return { path: joinPath(parent, raw), isDir: null };
}

async function listFilesRecursive(fs: FsBackend, root = "", limit = 5000): Promise<string[]> {
  const files: string[] = [];
  const seenDirs = new Set<string>();

  async function walk(dir: string): Promise<void> {
    if (files.length >= limit) return;
    const cleanDir = normalizePath(dir);
    if (seenDirs.has(cleanDir)) return;
    seenDirs.add(cleanDir);

    let entries: string[];
    try {
      entries = await fs.listDir(cleanDir || ".");
    } catch {
      return;
    }

    for (const raw of entries) {
      if (files.length >= limit) return;
      const entry = parseListedEntry(raw, cleanDir);
      if (!entry.path) continue;
      if (entry.isDir === true) {
        await walk(entry.path);
      } else if (entry.isDir === false) {
        files.push(entry.path);
      } else {
        try {
          await fs.readFile(entry.path);
          files.push(entry.path);
        } catch {
          await walk(entry.path);
        }
      }
    }
  }

  await walk(root);
  return [...new Set(files)].sort();
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(glob: string): RegExp {
  const normalized = normalizePath(glob || "**");
  let out = "^";
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    const afterNext = normalized[i + 2];
    if (ch === "*" && next === "*" && afterNext === "/") {
      out += "(?:.*/)?";
      i += 2;
    } else if (ch === "*" && next === "*") {
      out += ".*";
      i++;
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return new RegExp(`${out}$`);
}

function searchRegex(pattern: string, literal: boolean, caseInsensitive: boolean, global = false): RegExp {
  const source = literal ? escapeRegex(pattern) : pattern;
  return new RegExp(source, `${caseInsensitive ? "i" : ""}${global ? "g" : ""}`);
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function formatRange(content: string, startLine: number, endLine: number): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, startLine);
  const end = Math.min(lines.length, Math.max(start, endLine));
  return lines
    .slice(start - 1, end)
    .map((line, index) => `${start + index}: ${line}`)
    .join("\n");
}

async function listTree(fs: FsBackend, root = "", maxDepth = 3, maxEntries = 400): Promise<string[]> {
  const out: string[] = [];
  const seenDirs = new Set<string>();

  async function walk(dir: string, depth: number): Promise<void> {
    if (out.length >= maxEntries || depth > maxDepth) return;
    const cleanDir = normalizePath(dir);
    if (seenDirs.has(cleanDir)) return;
    seenDirs.add(cleanDir);

    let entries: ListedEntry[];
    try {
      entries = (await fs.listDir(cleanDir || "."))
        .map((raw) => parseListedEntry(raw, cleanDir))
        .filter((entry) => entry.path);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= maxEntries) return;
      const name = entry.path.split("/").pop() ?? entry.path;
      const prefix = depth === 0 ? "" : `${"  ".repeat(depth)}`;
      out.push(`${prefix}${entry.isDir === true ? "[dir] " : ""}${name}`);
      if (entry.isDir === true) await walk(entry.path, depth + 1);
    }
  }

  await walk(root, 0);
  return out;
}

function replacementPlan(content: string, matcher: RegExp, replace: string): { next: string; count: number } {
  let count = 0;
  const next = content.replace(matcher, () => {
    count += 1;
    return replace;
  });
  return { next, count };
}

function formatFileInfo(path: string, content: string): string {
  const bytes = new TextEncoder().encode(content).length;
  const lines = content.split(/\r?\n/).length;
  const extension = path.includes(".") ? path.split(".").pop() ?? "" : "";
  const hasBinaryMarkers = /[\u0000-\u0008\u000E-\u001F]/.test(content);
  return [
    `Path: ${path}`,
    "Type: file",
    `Bytes: ${bytes}`,
    `Lines: ${lines}`,
    `Extension: ${extension || "(none)"}`,
    `Looks binary: ${hasBinaryMarkers ? "yes" : "no"}`,
  ].join("\n");
}

function summarizeFiles(files: string[]): string {
  const byExt = new Map<string, number>();
  const byTop = new Map<string, number>();
  for (const file of files) {
    const name = file.split("/").pop() ?? file;
    const ext = name.includes(".") ? `.${name.split(".").pop()}` : "(none)";
    byExt.set(ext, (byExt.get(ext) ?? 0) + 1);
    const top = file.includes("/") ? file.split("/")[0] : "(root)";
    byTop.set(top, (byTop.get(top) ?? 0) + 1);
  }
  const fmt = (entries: [string, number][]) =>
    entries
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 20)
      .map(([key, count]) => `${key}: ${count}`)
      .join("\n");
  return [
    `Files: ${files.length}`,
    "",
    "By extension:",
    fmt([...byExt.entries()]) || "(none)",
    "",
    "By top folder:",
    fmt([...byTop.entries()]) || "(none)",
  ].join("\n");
}

export function createFsTools(fs: FsBackend): Tool[] {
  const tools: Tool[] = [
    {
      definition: {
        name: "read_file",
        description:
          "Read the full text contents of a file in the workspace. Use this to " +
          "understand code before changing it — you must read a file before you " +
          "can edit_file it. Prefer reading the specific file you need over " +
          "listing directories when you already know the path.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to the file." },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        const content = await fs.readFile(path);
        readPaths.add(readKey(path));
        return { ok: true, content };
      },
    },
    {
      definition: {
        name: "edit_file",
        description:
          "Make a targeted edit by replacing an exact string with a new one. This " +
          "is the preferred way to change existing files — it keeps the rest of the " +
          "file untouched. You MUST read_file first. 'find' must match the file " +
          "exactly (including indentation) and be unique; if it appears more than " +
          "once, include surrounding lines to disambiguate. Use write_file instead " +
          "only when creating a new file or rewriting one wholesale.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to the file." },
            find: { type: "string", description: "Exact text to replace. Must be unique in the file." },
            replace: { type: "string", description: "Text to replace it with." },
          },
          required: ["path", "find", "replace"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        const find = String(args.find);
        const replace = String(args.replace);

        if (!readPaths.has(readKey(path))) {
          return {
            ok: false,
            isError: true,
            content: `Refusing to edit ${path}: read it with read_file first so the edit isn't blind.`,
          };
        }
        const before = await fs.readFile(path);
        const first = before.indexOf(find);
        if (first === -1) {
          return {
            ok: false,
            isError: true,
            content: `'find' text not found in ${path}. Re-read the file; it may have changed or the match isn't exact.`,
          };
        }
        if (before.indexOf(find, first + find.length) !== -1) {
          return {
            ok: false,
            isError: true,
            content: `'find' text appears more than once in ${path}. Include more surrounding context to make it unique.`,
          };
        }
        const after = before.slice(0, first) + replace + before.slice(first + find.length);
        await fs.writeFile(path, after);
        return { ok: true, content: `Edited ${path}.` };
      },
    },
    {
      definition: {
        name: "write_file",
        description:
          "Create a new file, or fully overwrite an existing one, with the given " +
          "complete content. For changing part of a file that already exists, use " +
          "edit_file instead — it's safer and preserves the rest of the file. " +
          "Before overwriting a file you didn't create, read it first.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to write." },
            content: { type: "string", description: "Complete file content." },
          },
          required: ["path", "content"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        await fs.writeFile(path, String(args.content));
        readPaths.add(readKey(path)); // we now know its content
        return { ok: true, content: `Wrote ${path}.` };
      },
    },
    {
      definition: {
        name: "list_dir",
        description:
          "List the files and folders at a directory path. Use this to discover the " +
          "project structure or inspect a user-provided folder when you don't yet know " +
          "the exact file path. In the desktop app, path may be either relative to the " +
          "active workspace or an absolute directory path such as C:/Users/name/project. " +
          "Use '.' for the active workspace root. " +
          "If you already know the path, read_file directly instead.",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Directory path to list. Use '.' for the active workspace root; desktop builds also accept absolute paths.",
            },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const entries = await fs.listDir(listDirPathArg(args, ".") || ".");
        return { ok: true, content: entries.join("\n") };
      },
    },
    {
      definition: {
        name: "read_file_range",
        description:
          "Read a numbered line range from a workspace file. Use this for large files when only one section is needed.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." },
            start_line: { type: "number", description: "First one-based line number." },
            end_line: { type: "number", description: "Last one-based line number." },
          },
          required: ["path", "start_line", "end_line"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        const content = await fs.readFile(path);
        readPaths.add(readKey(path));
        const startLine = numberArg(args.start_line ?? args.startLine, 1, 1, 1_000_000);
        const endLine = numberArg(args.end_line ?? args.endLine, startLine + 199, startLine, 1_000_000);
        return { ok: true, content: formatRange(content, startLine, endLine) };
      },
    },
    {
      definition: {
        name: "read_many_files",
        description:
          "Read several workspace files in one call. Each file is capped to avoid flooding context.",
        inputSchema: {
          type: "object",
          properties: {
            paths: { type: "array", items: { type: "string" }, description: "Workspace-relative file paths." },
            max_chars_per_file: { type: "number", description: "Maximum characters per file, capped at 50000." },
          },
          required: ["paths"],
        },
      },
      async execute(args) {
        const paths = Array.isArray(args.paths) ? args.paths.map(String).map(normalizePath).filter(Boolean) : [];
        if (paths.length === 0) return { ok: false, isError: true, content: "No paths provided." };
        const maxChars = numberArg(args.max_chars_per_file ?? args.maxCharsPerFile, 12000, 1, 50000);
        const chunks: string[] = [];
        for (const path of paths.slice(0, 25)) {
          try {
            const content = await fs.readFile(path);
            readPaths.add(readKey(path));
            const truncated = content.length > maxChars;
            chunks.push([
              `--- ${path}${truncated ? ` (truncated to ${maxChars} chars)` : ""} ---`,
              content.slice(0, maxChars),
            ].join("\n"));
          } catch (err) {
            chunks.push(`--- ${path} ---\nERROR: ${String(err)}`);
          }
        }
        return { ok: true, content: chunks.join("\n\n") };
      },
    },
    {
      definition: {
        name: "write_many_files",
        description:
          "Create or overwrite several workspace files in one call. For changing existing files surgically, prefer edit_file/search_replace.",
        inputSchema: {
          type: "object",
          properties: {
            files: { type: "array", items: { type: "object" }, description: "Items with path and content." },
          },
          required: ["files"],
        },
      },
      async execute(args) {
        const files = Array.isArray(args.files) ? args.files : [];
        if (files.length === 0) return { ok: false, isError: true, content: "No files provided." };
        const written: string[] = [];
        for (const raw of files.slice(0, 50)) {
          const item = raw as Record<string, unknown>;
          const path = pathArg(item);
          if (!path) continue;
          await fs.writeFile(path, String(item.content ?? ""));
          readPaths.add(readKey(path));
          written.push(path);
        }
        return { ok: true, content: written.length ? `Wrote ${written.length} files:\n${written.join("\n")}` : "No valid files provided." };
      },
    },
    {
      definition: {
        name: "file_info",
        description:
          "Return lightweight information about a workspace file or directory, including size/line counts when readable.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file or directory path." },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const path = pathArg(args, ".");
        try {
          const content = await fs.readFile(path);
          return { ok: true, content: formatFileInfo(path, content) };
        } catch {
          const entries = await fs.listDir(path || ".");
          const dirs = entries.filter((entry) => entry.startsWith("dir ")).length;
          const files = entries.filter((entry) => entry.startsWith("file ")).length;
          return { ok: true, content: [`Path: ${path || "."}`, "Type: directory", `Entries: ${entries.length}`, `Directories: ${dirs}`, `Files: ${files}`].join("\n") };
        }
      },
    },
    {
      definition: {
        name: "project_files_summary",
        description:
          "Summarize workspace file counts by extension and top-level folder without returning every file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Optional directory to summarize." },
            max_files: { type: "number", description: "Maximum files to scan, capped at 10000." },
          },
        },
      },
      async execute(args) {
        const root = normalizePath(String(args.path ?? ""));
        const maxFiles = numberArg(args.max_files ?? args.maxFiles, 5000, 1, 10000);
        const files = await listFilesRecursive(fs, root, maxFiles);
        return { ok: true, content: summarizeFiles(files) };
      },
    },
    {
      definition: {
        name: "list_tree",
        description:
          "Show a compact directory tree with depth and entry limits. Use this instead of recursively listing every file.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Directory path. Defaults to workspace root." },
            max_depth: { type: "number", description: "Maximum depth, capped at 8." },
            max_entries: { type: "number", description: "Maximum entries, capped at 2000." },
          },
        },
      },
      async execute(args) {
        const root = listDirPathArg(args, ".") || ".";
        const maxDepth = numberArg(args.max_depth ?? args.maxDepth, 3, 0, 8);
        const maxEntries = numberArg(args.max_entries ?? args.maxEntries, 400, 1, 2000);
        const entries = await listTree(fs, root === "." ? "" : root, maxDepth, maxEntries);
        return { ok: true, content: entries.length ? entries.join("\n") : "No entries." };
      },
    },
    {
      definition: {
        name: "create_dir",
        description: "Create a workspace directory, including missing parent directories.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory path." },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        if (fs.createDir) {
          await fs.createDir(path);
        } else {
          await fs.writeFile(joinPath(path, ".keep"), "");
        }
        return { ok: true, content: `Created directory ${path}.` };
      },
    },
    {
      definition: {
        name: "delete_file",
        description:
          "Delete a workspace file or directory. This is destructive and requires confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file or directory path." },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        if (!fs.deletePath) return { ok: false, isError: true, content: "Filesystem backend does not support delete_file." };
        await fs.deletePath(path);
        return { ok: true, content: `Deleted ${path}.` };
      },
    },
    {
      definition: {
        name: "move_file",
        description:
          "Move or rename a workspace file or directory. This is destructive and requires confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            from: { type: "string", description: "Source workspace-relative path." },
            to: { type: "string", description: "Destination workspace-relative path." },
            src: { type: "string", description: "Alias for from." },
            dst: { type: "string", description: "Alias for to." },
          },
          required: ["from", "to"],
        },
      },
      async execute(args) {
        const from = pathArg({ path: args.from ?? args.src });
        const to = pathArg({ path: args.to ?? args.dst });
        if (!fs.movePath) return { ok: false, isError: true, content: "Filesystem backend does not support move_file." };
        await fs.movePath(from, to);
        return { ok: true, content: `Moved ${from} -> ${to}.` };
      },
    },
    {
      definition: {
        name: "search_replace",
        description:
          "Preview or apply a workspace-wide search/replace over files matched by an optional glob. Defaults to dryRun=true.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern or literal text to find." },
            replace: { type: "string", description: "Replacement text." },
            path: { type: "string", description: "Optional directory to search from." },
            glob: { type: "string", description: "Optional file glob, such as **/*.ts." },
            literal: { type: "boolean", description: "Treat pattern as plain text instead of regex." },
            case_insensitive: { type: "boolean", description: "Case-insensitive matching." },
            dryRun: { type: "boolean", description: "Preview without writing changes. Defaults to true." },
          },
          required: ["pattern", "replace"],
        },
      },
      async execute(args) {
        const root = normalizePath(String(args.path ?? ""));
        const pattern = String(args.pattern ?? "");
        if (!pattern) return { ok: false, isError: true, content: "Missing pattern." };
        const replace = String(args.replace ?? "");
        const fileGlob = args.glob ? globToRegex(root ? joinPath(root, String(args.glob)) : String(args.glob)) : null;
        const matcher = searchRegex(pattern, args.literal === true, args.case_insensitive === true, true);
        const files = (await listFilesRecursive(fs, root)).filter((file) => !fileGlob || fileGlob.test(file));
        const changed: string[] = [];
        let total = 0;
        for (const file of files) {
          let content: string;
          try {
            content = await fs.readFile(file);
          } catch {
            continue;
          }
          matcher.lastIndex = 0;
          const { next, count } = replacementPlan(content, matcher, replace);
          if (count === 0) continue;
          total += count;
          changed.push(`${file}: ${count}`);
          if (args.dryRun === false) {
            await fs.writeFile(file, next);
            readPaths.add(readKey(file));
          }
        }
        const mode = args.dryRun === false ? "Applied" : "Dry run";
        return {
          ok: true,
          content: changed.length
            ? `${mode}: ${total} replacements in ${changed.length} files.\n${changed.join("\n")}`
            : `${mode}: no matches.`,
        };
      },
    },
  ];

  tools.push(
    {
      definition: {
        name: "Read",
        description:
          "Claude-compatible alias for read_file. Reads the full text contents of a workspace file and marks it as eligible for Edit.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Workspace-relative path to the file." },
            path: { type: "string", description: "Alias for file_path." },
          },
          required: ["file_path"],
        },
      },
      async execute(args) {
        return tools[0].execute(args);
      },
    },
    {
      definition: {
        name: "Write",
        description:
          "Claude-compatible file writer. Creates a new file or overwrites a file that was already read in this session.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Workspace-relative path to write." },
            path: { type: "string", description: "Alias for file_path." },
            content: { type: "string", description: "Complete file content." },
          },
          required: ["file_path", "content"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        if (!readPaths.has(readKey(path))) {
          try {
            await fs.readFile(path);
            return {
              ok: false,
              isError: true,
              content: `Refusing to overwrite ${path}: read it with Read first. If this is a new file, choose a path that does not already exist.`,
            };
          } catch {
            // New file: allowed.
          }
        }
        await fs.writeFile(path, String(args.content ?? ""));
        readPaths.add(readKey(path));
        return { ok: true, content: `Wrote ${path}.` };
      },
    },
    {
      definition: {
        name: "Edit",
        description:
          "Claude-compatible exact string edit. Replaces old_string with new_string after the file has been read.",
        inputSchema: {
          type: "object",
          properties: {
            file_path: { type: "string", description: "Workspace-relative path to edit." },
            path: { type: "string", description: "Alias for file_path." },
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
          },
          required: ["file_path", "old_string", "new_string"],
        },
      },
      async execute(args) {
        const path = pathArg(args);
        const find = String(args.old_string ?? args.find ?? "");
        const replace = String(args.new_string ?? args.replace ?? "");
        const replaceAll = args.replace_all === true;
        if (!readPaths.has(readKey(path))) {
          return {
            ok: false,
            isError: true,
            content: `Refusing to edit ${path}: read it with Read first so the edit isn't blind.`,
          };
        }
        const before = await fs.readFile(path);
        const first = before.indexOf(find);
        if (first === -1) {
          return {
            ok: false,
            isError: true,
            content: `old_string text not found in ${path}. Re-read the file; it may have changed or the match isn't exact.`,
          };
        }
        if (!replaceAll && before.indexOf(find, first + find.length) !== -1) {
          return {
            ok: false,
            isError: true,
            content: `old_string appears more than once in ${path}. Include more surrounding context or set replace_all=true.`,
          };
        }
        const after = replaceAll ? before.split(find).join(replace) : before.slice(0, first) + replace + before.slice(first + find.length);
        await fs.writeFile(path, after);
        return { ok: true, content: `Edited ${path}.` };
      },
    },
    {
      definition: {
        name: "Glob",
        description:
          "Claude-compatible file glob. Finds workspace files matching a glob pattern such as **/*.ts.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern to match." },
            path: { type: "string", description: "Optional directory to search from." },
          },
          required: ["pattern"],
        },
      },
      async execute(args) {
        const root = normalizePath(String(args.path ?? ""));
        const pattern = String(args.pattern ?? "**");
        const rootPattern = root ? joinPath(root, pattern) : normalizePath(pattern);
        const re = globToRegex(rootPattern);
        const files = (await listFilesRecursive(fs, root)).filter((file) => re.test(file));
        return { ok: true, content: files.length ? files.join("\n") : "No files matched." };
      },
    },
    {
      definition: {
        name: "Grep",
        description:
          "Claude-compatible workspace text search. Searches files by regex or literal text and returns file:line:content matches.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern or literal search text." },
            path: { type: "string", description: "Optional directory to search from." },
            glob: { type: "string", description: "Optional file glob, such as **/*.tsx." },
            output_mode: { type: "string", description: "content, files_with_matches, or count." },
            literal: { type: "boolean", description: "Treat pattern as plain text instead of regex." },
            case_insensitive: { type: "boolean", description: "Case-insensitive matching." },
          },
          required: ["pattern"],
        },
      },
      async execute(args) {
        const root = normalizePath(String(args.path ?? ""));
        const pattern = String(args.pattern ?? "");
        const outputMode = String(args.output_mode ?? "files_with_matches");
        const fileGlob = args.glob ? globToRegex(root ? joinPath(root, String(args.glob)) : String(args.glob)) : null;
        const matcher = searchRegex(pattern, args.literal === true, args.case_insensitive === true);
        const files = (await listFilesRecursive(fs, root)).filter((file) => !fileGlob || fileGlob.test(file));
        const lines: string[] = [];
        for (const file of files) {
          let content: string;
          try {
            content = await fs.readFile(file);
          } catch {
            continue;
          }
          const matches = content.split(/\r?\n/).flatMap((line, index) =>
            matcher.test(line) ? [{ line, number: index + 1 }] : [],
          );
          if (matches.length === 0) continue;
          if (outputMode === "files_with_matches") {
            lines.push(file);
          } else if (outputMode === "count") {
            lines.push(`${file}:${matches.length}`);
          } else {
            lines.push(...matches.map((m) => `${file}:${m.number}: ${m.line}`));
          }
        }
        return { ok: true, content: lines.length ? lines.join("\n") : "No matches." };
      },
    },
    {
      definition: {
        name: "glob_files",
        description:
          "Rush-compatible file glob. Finds workspace files matching a glob pattern such as **/*.ts. Alias for Glob.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern to match." },
            path: { type: "string", description: "Optional directory to search from." },
          },
          required: ["pattern"],
        },
      },
      async execute(args) {
        return tools.find((tool) => tool.definition.name === "Glob")!.execute(args);
      },
    },
    {
      definition: {
        name: "grep_search",
        description:
          "Rush-compatible workspace text search. Searches files by regex or literal text. Alias for Grep.",
        inputSchema: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regex pattern or literal search text." },
            path: { type: "string", description: "Optional directory to search from." },
            glob: { type: "string", description: "Optional file glob, such as **/*.tsx." },
            output_mode: { type: "string", description: "content, files_with_matches, or count." },
            literal: { type: "boolean", description: "Treat pattern as plain text instead of regex." },
            case_insensitive: { type: "boolean", description: "Case-insensitive matching." },
          },
          required: ["pattern"],
        },
      },
      async execute(args) {
        return tools.find((tool) => tool.definition.name === "Grep")!.execute(args);
      },
    },
  );

  return tools;
}
