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
    for (const name of ["read_file", "write_file", "edit_file", "Read", "Write", "Edit", "Glob", "Grep"]) {
      expect(tools.has(name)).toBe(true);
    }
  });

  it("documents list_dir as workspace-relative", () => {
    const tools = toolMap({});
    const listDir = tools.get("list_dir")!.definition;

    expect(listDir.description).toContain("relative to the active workspace");
    expect(listDir.description).toContain("use '.'");
    expect(listDir.inputSchema.properties.path).toEqual(
      expect.objectContaining({
        description: expect.stringContaining("active workspace root"),
      }),
    );
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
});
