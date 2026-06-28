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

function searchRegex(pattern: string, literal: boolean, caseInsensitive: boolean): RegExp {
  const source = literal ? escapeRegex(pattern) : pattern;
  return new RegExp(source, caseInsensitive ? "i" : "");
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
        const entries = await fs.listDir(pathArg(args, ".") || ".");
        return { ok: true, content: entries.join("\n") };
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
  );

  return tools;
}
