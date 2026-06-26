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

export function createFsTools(fs: FsBackend): Tool[] {
  return [
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
        const path = String(args.path);
        const content = await fs.readFile(path);
        readPaths.add(path);
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
        const path = String(args.path);
        const find = String(args.find);
        const replace = String(args.replace);

        if (!readPaths.has(path)) {
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
        const path = String(args.path);
        await fs.writeFile(path, String(args.content));
        readPaths.add(path); // we now know its content
        return { ok: true, content: `Wrote ${path}.` };
      },
    },
    {
      definition: {
        name: "list_dir",
        description:
          "List the files and folders at a workspace path. Use this to discover the " +
          "project structure or find a file when you don't yet know its exact path. " +
          "If you already know the path, read_file directly instead.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory path. Use '.' for the root." },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const entries = await fs.listDir(String(args.path));
        return { ok: true, content: entries.join("\n") };
      },
    },
  ];
}
