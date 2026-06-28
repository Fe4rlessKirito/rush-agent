import { describe, expect, it } from "vitest";
import { createBackgroundTools, type BackgroundBackend, type BackgroundJobSummary } from "./backgroundTools";

function mockBackend(): { backend: BackgroundBackend; calls: string[] } {
  const calls: string[] = [];
  const job: BackgroundJobSummary = {
    id: "job_1",
    command: "npm run dev",
    shell: "powershell",
    status: "running",
    created_at: 1,
  };
  return {
    calls,
    backend: {
      async start(args) {
        calls.push(`start:${args.shell ?? ""}:${args.command}`);
        return { ...job, command: args.command, shell: args.shell ?? "powershell" };
      },
      async read(id) {
        calls.push(`read:${id}`);
        return { id, status: "running", output: "server ready" };
      },
      async list() {
        calls.push("list");
        return [job];
      },
      async stop(id) {
        calls.push(`stop:${id}`);
        return `Stopped ${id}.`;
      },
    },
  };
}

function toolMap(backend: BackgroundBackend) {
  return new Map(createBackgroundTools(backend).map((tool) => [tool.definition.name, tool]));
}

describe("background tools", () => {
  it("starts and monitors a background command", async () => {
    const { backend, calls } = mockBackend();
    const tools = toolMap(backend);

    const result = await tools.get("Monitor")!.execute({
      command: "npm run dev",
      shell: "powershell",
      description: "Watch dev server",
    });

    expect(result.ok).toBe(true);
    expect(result.content).toContain("Monitor started");
    expect(result.content).toContain("job_1");
    expect(calls).toEqual(["start:powershell:npm run dev"]);
  });

  it("reads, lists, and stops jobs", async () => {
    const { backend, calls } = mockBackend();
    const tools = toolMap(backend);

    expect((await tools.get("background_read")!.execute({ id: "job_1" })).content).toContain("server ready");
    expect((await tools.get("background_list")!.execute({})).content).toContain("npm run dev");
    expect((await tools.get("background_stop")!.execute({ id: "job_1" })).content).toContain("Stopped job_1");
    expect(calls).toEqual(["read:job_1", "list", "stop:job_1"]);
  });
});
