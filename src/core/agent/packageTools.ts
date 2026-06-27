import { invoke } from "@tauri-apps/api/core";
import type { Tool } from "./tools";

async function callPackage(command: string, args: Record<string, unknown> = {}) {
  try {
    const content = await invoke<string>(command, args);
    return { ok: true, content: content || "Done." };
  } catch (err) {
    return { ok: false, isError: true, content: String(err) };
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String).map((v) => v.trim()).filter(Boolean);
}

export function createPackageTools(): Tool[] {
  return [
    {
      definition: {
        name: "npm_scripts",
        description: "List npm scripts from the active workspace package.json.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callPackage("npm_scripts"),
    },
    {
      definition: {
        name: "npm_run_script",
        description:
          "Run an npm script in the active workspace. Use this for npm build, test, lint, dev, or project-specific scripts.",
        inputSchema: {
          type: "object",
          properties: {
            script: { type: "string", description: "Script name from package.json." },
            args: { type: "array", description: "Optional extra arguments passed after --." },
          },
          required: ["script"],
        },
      },
      execute: (args) =>
        callPackage("npm_run_script", {
          script: String(args.script ?? ""),
          args: stringList(args.args),
        }),
    },
    {
      definition: {
        name: "npm_install",
        description:
          "Install one or more npm packages in the active workspace. Set dev=true for devDependencies.",
        inputSchema: {
          type: "object",
          properties: {
            packages: { type: "array", description: "Package names to install." },
            dev: { type: "boolean", description: "Install as devDependencies." },
          },
          required: ["packages"],
        },
      },
      execute: (args) =>
        callPackage("npm_install", {
          packages: stringList(args.packages),
          dev: Boolean(args.dev),
        }),
    },
    {
      definition: {
        name: "npm_ci",
        description: "Run npm ci in the active workspace.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callPackage("npm_ci"),
    },
    {
      definition: {
        name: "cargo_check",
        description: "Run cargo check in the active workspace.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callPackage("cargo_check_cmd"),
    },
    {
      definition: {
        name: "cargo_test",
        description: "Run cargo test in the active workspace.",
        inputSchema: { type: "object", properties: {} },
      },
      execute: () => callPackage("cargo_test_cmd"),
    },
    {
      definition: {
        name: "cargo_build",
        description: "Run cargo build in the active workspace. Set release=true for --release.",
        inputSchema: {
          type: "object",
          properties: {
            release: { type: "boolean", description: "Build with --release." },
          },
        },
      },
      execute: (args) => callPackage("cargo_build_cmd", { release: Boolean(args.release) }),
    },
    {
      definition: {
        name: "pip_install",
        description: "Install one or more Python packages with python -m pip install.",
        inputSchema: {
          type: "object",
          properties: {
            packages: { type: "array", description: "Python package names to install." },
          },
          required: ["packages"],
        },
      },
      execute: (args) => callPackage("pip_install", { packages: stringList(args.packages) }),
    },
    {
      definition: {
        name: "winget_search",
        description: "Search Windows packages with winget search.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Package search query." },
          },
          required: ["query"],
        },
      },
      execute: (args) => callPackage("winget_search", { query: String(args.query ?? "") }),
    },
  ];
}
