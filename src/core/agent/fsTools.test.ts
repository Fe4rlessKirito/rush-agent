import { describe, expect, it } from "vitest";
import { createDevFs } from "./devFs";
import { createFsTools } from "./fsTools";

function toolMap(seed: Record<string, string>) {
  const tools = createFsTools(createDevFs(seed));
  return new Map(tools.map((tool) => [tool.definition.name, tool]));
}

describe("Claude-compatible filesystem tools", () => {
  it("registers both Rush and Claude-compatible tool names", () => {
    const tools = toolMap({});
    for (const name of [
      "read_file",
      "read_file_range",
      "read_many_files",
      "write_file",
      "write_many_files",
      "file_info",
      "project_files_summary",
      "edit_file",
      "list_tree",
      "create_dir",
      "delete_file",
      "move_file",
      "search_replace",
      "Read",
      "Write",
      "Edit",
      "Glob",
      "Grep",
      "glob_files",
      "grep_search",
    ]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("documents list_dir as accepting workspace-relative and absolute paths", () => {
    const tools = toolMap({});
    const listDir = tools.get("list_dir")!.definition;

    expect(listDir.description).toContain("relative to the active workspace");
    expect(listDir.description).toContain("absolute directory path");
    expect(listDir.description).toContain("Use '.'");
    expect(listDir.inputSchema.properties.path).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("absolute paths"),
      }),
    );
  });

  it("passes absolute paths through to list_dir without workspace normalization", async () => {
    const seen: string[] = [];
    const tools = createFsTools({
      async readFile() {
        throw new Error("not used");
      },
      async writeFile() {
        throw new Error("not used");
      },
      async listDir(path) {
        seen.push(path);
        return ["file C:/Users/marko/Downloads/oblivian/app.py"];
      },
    });
    const listDir = tools.find((tool) => tool.definition.name === "list_dir")!;

    const result = await listDir.execute({ path: "C:\\Users\\marko\\Downloads\\oblivian" });

    expect(seen).toEqual(["C:/Users/marko/Downloads/oblivian"]);
    expect(result.content).toContain("app.py");
  });

  it("requires Read before Edit", async () => {
    const tools = toolMap({ "src/a.ts": "const value = 1;\n" });

    const blind = await tools.get("Edit")!.execute({
      file_path: "src/a.ts",
      old_string: "1",
      new_string: "2",
    });
    expect(blind.ok).toBe(false);

    await tools.get("Read")!.execute({ file_path: "src/a.ts" });
    const edited = await tools.get("Edit")!.execute({
      file_path: "src/a.ts",
      old_string: "1",
      new_string: "2",
    });
    expect(edited.ok).toBe(true);
    const read = await tools.get("Read")!.execute({ file_path: "src/a.ts" });
    expect(read.content).toContain("2");
  });

  it("reads a numbered line range", async () => {
    const tools = toolMap({ "src/a.ts": "one\ntwo\nthree\nfour\n" });

    const result = await tools.get("read_file_range")!.execute({
      path: "src/a.ts",
      start_line: 2,
      end_line: 3,
    });

    expect(result.content).toBe("2: two\n3: three");
  });

  it("reads many files with per-file caps", async () => {
    const tools = toolMap({ "a.txt": "abcdef", "b.txt": "123456" });

    const result = await tools.get("read_many_files")!.execute({
      paths: ["a.txt", "b.txt"],
      max_chars_per_file: 3,
    });

    expect(result.content).toContain("--- a.txt (truncated to 3 chars) ---\nabc");
    expect(result.content).toContain("--- b.txt (truncated to 3 chars) ---\n123");
  });

  it("writes many files", async () => {
    const tools = toolMap({});

    const result = await tools.get("write_many_files")!.execute({
      files: [
        { path: "a.txt", content: "a" },
        { path: "b.txt", content: "b" },
      ],
    });

    expect(result.content).toContain("Wrote 2 files");
    expect((await tools.get("Read")!.execute({ file_path: "a.txt" })).content).toBe("a");
  });

  it("reports file info and project summaries", async () => {
    const tools = toolMap({
      "src/a.ts": "one\ntwo\n",
      "README.md": "readme",
    });

    expect((await tools.get("file_info")!.execute({ path: "src/a.ts" })).content).toContain("Lines: 3");
    const summary = await tools.get("project_files_summary")!.execute({});
    expect(summary.content).toContain(".ts: 1");
    expect(summary.content).toContain(".md: 1");
  });

  it("lists a compact tree", async () => {
    const tools = toolMap({
      "src/a.ts": "a",
      "src/nested/b.ts": "b",
      "README.md": "readme",
    });

    const result = await tools.get("list_tree")!.execute({ max_depth: 1 });

    expect(result.content).toContain("[dir] src");
    expect(result.content).toContain("README.md");
  });

  it("creates, moves, and deletes paths when the backend supports it", async () => {
    const tools = toolMap({ "src/a.ts": "a" });

    expect((await tools.get("create_dir")!.execute({ path: "src/new" })).ok).toBe(true);
    expect((await tools.get("move_file")!.execute({ from: "src/a.ts", to: "src/new/a.ts" })).ok).toBe(true);
    expect((await tools.get("Read")!.execute({ file_path: "src/new/a.ts" })).content).toBe("a");
    expect((await tools.get("delete_file")!.execute({ path: "src/new/a.ts" })).ok).toBe(true);
  });

  it("finds files with Glob", async () => {
    const tools = toolMap({
      "src/a.ts": "a",
      "src/b.tsx": "b",
      "README.md": "readme",
    });

    const result = await tools.get("Glob")!.execute({ pattern: "src/**/*.ts*" });
    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("src/b.tsx");
    expect(result.content).not.toContain("README.md");
  });

  it("finds files with the glob_files alias", async () => {
    const tools = toolMap({
      "src/a.ts": "a",
      "src/b.tsx": "b",
      "README.md": "readme",
    });

    const result = await tools.get("glob_files")!.execute({ pattern: "src/**/*.ts*" });
    expect(result.content).toContain("src/a.ts");
    expect(result.content).toContain("src/b.tsx");
    expect(result.content).not.toContain("README.md");
  });

  it("searches file contents with Grep", async () => {
    const tools = toolMap({
      "src/a.ts": "alpha\nneedle\n",
      "src/b.ts": "nothing\n",
    });

    const result = await tools.get("Grep")!.execute({
      pattern: "needle",
      glob: "src/**/*.ts",
      output_mode: "content",
      literal: true,
    });
    expect(result.content).toContain("src/a.ts:2: needle");
    expect(result.content).not.toContain("src/b.ts");
  });

  it("searches file contents with the grep_search alias", async () => {
    const tools = toolMap({
      "src/a.ts": "alpha\nneedle\n",
      "src/b.ts": "nothing\n",
    });

    const result = await tools.get("grep_search")!.execute({
      pattern: "needle",
      glob: "src/**/*.ts",
      output_mode: "content",
      literal: true,
    });
    expect(result.content).toContain("src/a.ts:2: needle");
    expect(result.content).not.toContain("src/b.ts");
  });

  it("previews and applies search_replace", async () => {
    const tools = toolMap({
      "src/a.ts": "alpha\nalpha\n",
      "src/b.ts": "alpha\n",
    });

    const preview = await tools.get("search_replace")!.execute({
      pattern: "alpha",
      replace: "beta",
      glob: "src/**/*.ts",
      literal: true,
    });
    expect(preview.content).toContain("Dry run: 3 replacements");

    const applied = await tools.get("search_replace")!.execute({
      pattern: "alpha",
      replace: "beta",
      glob: "src/**/*.ts",
      literal: true,
      dryRun: false,
    });
    expect(applied.content).toContain("Applied: 3 replacements");
    expect((await tools.get("Read")!.execute({ file_path: "src/a.ts" })).content).toContain("beta");
  });
});
