import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCodeTools } from "./codeTools";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function tool(name: string) {
  const found = createCodeTools().find((item) => item.definition.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

describe("codeTools LSP wrappers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("registers LSP tools before heuristic code tools", () => {
    const names = createCodeTools().map((item) => item.definition.name);

    expect(names.slice(0, 5)).toEqual([
      "lsp_start",
      "lsp_find_definition",
      "lsp_find_references",
      "lsp_prepare_rename",
      "lsp_stop",
    ]);
    expect(names).toContain("code_find_definition");
  });

  it("starts an LSP server with the expected Tauri args", async () => {
    invokeMock.mockResolvedValue({ status: "initialized", language: "typescript" });

    const result = await tool("lsp_start").execute({
      language: "typescript",
      rootPath: "C:/repo",
    });

    expect(invokeMock).toHaveBeenCalledWith("lsp_start", {
      language: "typescript",
      rootPath: "C:/repo",
    });
    expect(result).toEqual({
      ok: true,
      content: JSON.stringify({ status: "initialized", language: "typescript" }, null, 2),
    });
  });

  it("calls precise LSP definition and reference commands with zero-based positions", async () => {
    invokeMock.mockResolvedValueOnce([{ uri: "file:///C:/repo/src/a.ts", range: { start: { line: 2, character: 4 } } }]);
    invokeMock.mockResolvedValueOnce([{ uri: "file:///C:/repo/src/b.ts", range: { start: { line: 8, character: 1 } } }]);

    await tool("lsp_find_definition").execute({
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 10,
      character: 7,
    });
    await tool("lsp_find_references").execute({
      language: "typescript",
      file_path: "C:/repo/src/a.ts",
      line: 10,
      character: 7,
    });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "lsp_definition", {
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 10,
      character: 7,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "lsp_references", {
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 10,
      character: 7,
    });
  });

  it("returns an explicit error when LSP is unavailable and no fallback symbol is provided", async () => {
    invokeMock.mockRejectedValue("LSP for 'typescript' not started");

    const result = await tool("lsp_find_definition").execute({
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 0,
      character: 0,
    });

    expect(result).toEqual({
      ok: false,
      isError: true,
      content: "LSP for 'typescript' not started",
    });
  });

  it("falls back to heuristic definition search when LSP fails and a symbol is provided", async () => {
    invokeMock.mockRejectedValueOnce("LSP for 'typescript' not started");
    invokeMock.mockResolvedValueOnce([
      { path: "src/a.ts", line: 3, column: 8, text: "function loadUser() {}" },
    ]);

    const result = await tool("lsp_find_definition").execute({
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 0,
      character: 0,
      symbol: "loadUser",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(2, "code_find_definition", {
      symbol: "loadUser",
      limit: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("LSP failed: LSP for 'typescript' not started");
    expect(result.content).toContain("src/a.ts:3:8: function loadUser() {}");
  });

  it("falls back to heuristic symbol search when LSP references fail and a symbol is provided", async () => {
    invokeMock.mockRejectedValueOnce("LSP request 'textDocument/references' timed out");
    invokeMock.mockResolvedValueOnce([
      { path: "src/b.ts", line: 9, column: 12, text: "loadUser();" },
    ]);

    const result = await tool("lsp_find_references").execute({
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 0,
      character: 0,
      symbol: "loadUser",
    });

    expect(invokeMock).toHaveBeenNthCalledWith(2, "code_find_symbol", {
      symbol: "loadUser",
      limit: 20,
    });
    expect(result.ok).toBe(true);
    expect(result.content).toContain("Heuristic fallback:");
    expect(result.content).toContain("src/b.ts:9:12: loadUser();");
  });

  it("keeps heuristic definition formatting unchanged", async () => {
    invokeMock.mockResolvedValue([
      { path: "src/a.ts", line: 3, column: 8, text: "function loadUser() {}" },
    ]);

    const result = await tool("code_find_definition").execute({ symbol: "loadUser", limit: 5 });

    expect(invokeMock).toHaveBeenCalledWith("code_find_definition", {
      symbol: "loadUser",
      limit: 5,
    });
    expect(result.content).toBe("src/a.ts:3:8: function loadUser() {}");
  });

  it("prepares an LSP rename edit without applying it", async () => {
    invokeMock.mockResolvedValue({ changes: { "file:///C:/repo/src/a.ts": [] } });

    const result = await tool("lsp_prepare_rename").execute({
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 4,
      character: 2,
      new_name: "loadAccount",
    });

    expect(invokeMock).toHaveBeenCalledWith("lsp_rename", {
      language: "typescript",
      filePath: "C:/repo/src/a.ts",
      line: 4,
      character: 2,
      newName: "loadAccount",
    });
    expect(result.content).toContain("file:///C:/repo/src/a.ts");
  });
});
