import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../store";
import type { Tool, ToolResult } from "./tools";

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

type LspValue = unknown;

function formatMatches(matches: CodeMatch[]) {
  if (!matches.length) return "No matches.";
  return matches
    .map((m) => `${m.path}:${m.line}:${m.column}: ${m.text}`)
    .join("\n");
}

function formatLspValue(value: LspValue): string {
  if (value === null || value === undefined) return "No LSP result.";
  return JSON.stringify(value, null, 2);
}

async function callCode<T>(command: string, args: Record<string, unknown>, format: (value: T) => string) {
  try {
    const value = await invoke<T>(command, args);
    return { ok: true, content: format(value) };
  } catch (err) {
    return { ok: false, isError: true, content: String(err) };
  }
}

async function callLspWithSymbolFallback<T>(
  command: string,
  args: Record<string, unknown>,
  format: (value: T) => string,
  fallbackCommand: "code_find_definition" | "code_find_symbol",
  fallbackSymbol: string,
): Promise<ToolResult> {
  const lspResult = await callCode<T>(command, args, format);
  if (lspResult.ok || !fallbackSymbol.trim()) return lspResult;

  try {
    const value = await invoke<CodeMatch[]>(fallbackCommand, {
      symbol: fallbackSymbol.trim(),
      limit: 20,
    });
    return {
      ok: true,
      content: [
        `LSP failed: ${lspResult.content}`,
        "Heuristic fallback:",
        formatMatches(value),
      ].join("\n"),
    };
  } catch (err) {
    return {
      ok: false,
      isError: true,
      content: `${lspResult.content}\nFallback failed: ${String(err)}`,
    };
  }
}

function optionalLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function lspLaunchArgs(language: string): { binaryPath?: string; preferBundled?: boolean } {
  const normalized = language.toLowerCase().startsWith("rust") || language.toLowerCase() === "rs"
    ? "rust"
    : "typescript";
  const config = useAppStore.getState().languageServerSettings[normalized];
  if (config.mode === "custom") return { binaryPath: config.customPath };
  if (config.mode === "bundled") return { preferBundled: true };
  return {};
}

function notifyLspMissing(language: string, message: string) {
  if (typeof window === "undefined") return;
  const normalized = language.toLowerCase().startsWith("rust") || language.toLowerCase() === "rs"
    ? "rust"
    : "typescript";
  window.dispatchEvent(new CustomEvent("rush:lsp-missing", {
    detail: { language: normalized, message },
  }));
}

export function createCodeTools(): Tool[] {
  return [
    {
      definition: {
        name: "lsp_start",
        description:
          "Start a language server for precise code intelligence. Use before lsp_find_definition, lsp_find_references, or lsp_prepare_rename. If this fails, fall back to code_find_definition/code_find_symbol.",
        inputSchema: {
          type: "object",
          properties: {
            language: { type: "string", description: "Language key: rust, typescript, ts, javascript, or js." },
            rootPath: { type: "string", description: "Absolute project root path for the language server." },
          },
          required: ["language", "rootPath"],
        },
      },
      execute: async (args) => {
        const language = String(args.language ?? "");
        const result = await callCode<LspValue>(
          "lsp_start",
          {
            language,
            rootPath: String(args.rootPath ?? ""),
            ...lspLaunchArgs(language),
          },
          formatLspValue,
        );
        if (!result.ok && /failed to spawn|not found|cannot find|no such file/i.test(result.content)) {
          notifyLspMissing(language, result.content);
        }
        return result;
      },
    },
    {
      definition: {
        name: "lsp_find_definition",
        description:
          "Use a running LSP server to find the precise definition at a file position. Positions are zero-based. If no LSP is running or it fails, use code_find_definition as fallback.",
        inputSchema: {
          type: "object",
          properties: {
            language: { type: "string", description: "Language key used with lsp_start." },
            filePath: { type: "string", description: "Absolute file path." },
            line: { type: "number", description: "Zero-based line number." },
            character: { type: "number", description: "Zero-based UTF-16-ish character offset." },
            symbol: { type: "string", description: "Optional identifier for heuristic fallback if LSP is unavailable." },
          },
          required: ["language", "filePath", "line", "character"],
        },
      },
      execute: (args) =>
        callLspWithSymbolFallback<LspValue>(
          "lsp_definition",
          {
            language: String(args.language ?? ""),
            filePath: String(args.filePath ?? args.file_path ?? ""),
            line: num(args.line),
            character: num(args.character),
          },
          formatLspValue,
          "code_find_definition",
          String(args.symbol ?? ""),
        ),
    },
    {
      definition: {
        name: "lsp_find_references",
        description:
          "Use a running LSP server to find precise references at a file position. Positions are zero-based. If no LSP is running or it fails, use code_find_symbol as fallback.",
        inputSchema: {
          type: "object",
          properties: {
            language: { type: "string", description: "Language key used with lsp_start." },
            filePath: { type: "string", description: "Absolute file path." },
            line: { type: "number", description: "Zero-based line number." },
            character: { type: "number", description: "Zero-based UTF-16-ish character offset." },
            symbol: { type: "string", description: "Optional identifier for heuristic fallback if LSP is unavailable." },
          },
          required: ["language", "filePath", "line", "character"],
        },
      },
      execute: (args) =>
        callLspWithSymbolFallback<LspValue>(
          "lsp_references",
          {
            language: String(args.language ?? ""),
            filePath: String(args.filePath ?? args.file_path ?? ""),
            line: num(args.line),
            character: num(args.character),
          },
          formatLspValue,
          "code_find_symbol",
          String(args.symbol ?? ""),
        ),
    },
    {
      definition: {
        name: "lsp_prepare_rename",
        description:
          "Ask a running LSP server for a workspace edit to rename the symbol at a file position. This returns the edit plan only; inspect it before applying changes manually.",
        inputSchema: {
          type: "object",
          properties: {
            language: { type: "string", description: "Language key used with lsp_start." },
            filePath: { type: "string", description: "Absolute file path." },
            line: { type: "number", description: "Zero-based line number." },
            character: { type: "number", description: "Zero-based UTF-16-ish character offset." },
            newName: { type: "string", description: "New symbol name." },
          },
          required: ["language", "filePath", "line", "character", "newName"],
        },
      },
      execute: (args) =>
        callCode<LspValue>(
          "lsp_rename",
          {
            language: String(args.language ?? ""),
            filePath: String(args.filePath ?? args.file_path ?? ""),
            line: num(args.line),
            character: num(args.character),
            newName: String(args.newName ?? args.new_name ?? ""),
          },
          formatLspValue,
        ),
    },
    {
      definition: {
        name: "lsp_stop",
        description:
          "Stop a running language server when it is no longer needed.",
        inputSchema: {
          type: "object",
          properties: {
            language: { type: "string", description: "Language key used with lsp_start." },
          },
          required: ["language"],
        },
      },
      execute: (args) =>
        callCode<LspValue>(
          "lsp_stop",
          { language: String(args.language ?? "") },
          formatLspValue,
        ),
    },
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
