import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

interface CodeMatch {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface RenameResult {
  files_changed: number;
  replacements: number;
  files: string[];
}

function formatMatches(matches: CodeMatch[]) {
  if (!matches.length) return "No matches.";
  return matches
    .map((m) => `${m.path}:${m.line}:${m.column}: ${m.text}`)
    .join("\n");
}

async function callCode<T>(command: string, args: Record<string, unknown>, format: (value: T) => string) {
  try {
    const value = await invoke<T>(command, args);
    return { ok: true, content: format(value) };
  } catch (err) {
    return { ok: false, isError: true, content: String(err) };
  }
}

function optionalLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createCodeTools(): Tool[] {
  return [
    {
      definition: {
        name: "code_find_symbol",
        description:
          "Find usages of an identifier across code files in the active workspace. Returns path:line:column matches.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Identifier to search for." },
            limit: { type: "number", description: "Maximum matches to return." },
          },
          required: ["symbol"],
        },
      },
      execute: (args) =>
        callCode<CodeMatch[]>(
          "code_find_symbol",
          { symbol: String(args.symbol ?? ""), limit: optionalLimit(args.limit) },
          formatMatches,
        ),
    },
    {
      definition: {
        name: "code_find_definition",
        description:
          "Find likely definitions for an identifier across code files in the active workspace.",
        inputSchema: {
          type: "object",
          properties: {
            symbol: { type: "string", description: "Identifier to locate." },
            limit: { type: "number", description: "Maximum matches to return." },
          },
          required: ["symbol"],
        },
      },
      execute: (args) =>
        callCode<CodeMatch[]>(
          "code_find_definition",
          { symbol: String(args.symbol ?? ""), limit: optionalLimit(args.limit) },
          formatMatches,
        ),
    },
    {
      definition: {
        name: "code_rename_identifier",
        description:
          "Rename an identifier across supported code files using whole-identifier matching. Use dryRun=true first to preview affected files.",
        inputSchema: {
          type: "object",
          properties: {
            oldName: { type: "string", description: "Existing identifier." },
            newName: { type: "string", description: "Replacement identifier." },
            dryRun: { type: "boolean", description: "Preview without writing changes." },
          },
          required: ["oldName", "newName"],
        },
      },
      execute: (args) =>
        callCode<RenameResult>(
          "code_rename_identifier",
          {
            oldName: String(args.oldName ?? ""),
            newName: String(args.newName ?? ""),
            dryRun: args.dryRun !== false,
          },
          (result) =>
            [
              `${result.files_changed} files, ${result.replacements} replacements.`,
              ...result.files,
            ].join("\n"),
        ),
    },
  ];
}
