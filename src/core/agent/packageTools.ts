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

function hasScript(scripts: string, name: string): boolean {
  try {
    const parsed = JSON.parse(scripts) as Record<string, string>;
    return typeof parsed[name] === "string";
  } catch {
    return scripts.includes(`"${name}"`) || new RegExp(`^${name}\\b`, "m").test(scripts);
  }
}

async function runNpmScriptIfPresent(script: string, args: string[] = []) {
  const scripts = await callPackage("npm_scripts");
  if (!scripts.ok) return null;
  if (!hasScript(scripts.content, script)) return null;
  return callPackage("npm_run_script", { script, args });
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
        name: "run_tests",
        description:
          "Run the project's test suite. Auto-detects npm test first, then Cargo tests. Set kind to npm or cargo to force one.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Optional: auto, npm, or cargo." },
            args: { type: "array", description: "Optional extra test arguments." },
          },
        },
      },
      async execute(args) {
        const kind = String(args.kind ?? "auto").toLowerCase();
        const extra = stringList(args.args);
        if (kind === "npm" || kind === "auto") {
          const scripts = await callPackage("npm_scripts");
          if (scripts.ok) {
            const hasTest = hasScript(scripts.content, "test");
            if (hasTest || kind === "npm") {
              return callPackage("npm_run_script", { script: "test", args: extra });
            }
          } else if (kind === "npm") {
            return scripts;
          }
        }
        if (kind === "cargo" || kind === "auto") {
          return callPackage("cargo_test_cmd");
        }
        return { ok: false, isError: true, content: `Unknown test kind: ${kind}` };
      },
    },
    {
      definition: {
        name: "diagnostics",
        description:
          "Run project diagnostics. Auto mode tries npm build, npm test, and cargo check where available.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Optional: auto, npm, cargo, or all." },
          },
        },
      },
      async execute(args) {
        const kind = String(args.kind ?? "auto").toLowerCase();
        const results: string[] = [];
        if (kind === "npm" || kind === "auto" || kind === "all") {
          const build = await runNpmScriptIfPresent("build");
          if (build) results.push(`npm build:\n${build.content}`);
          const test = await runNpmScriptIfPresent("test");
          if (test) results.push(`npm test:\n${test.content}`);
          if ((kind === "npm" || kind === "all") && !build && !test) results.push("npm: no build/test scripts found.");
        }
        if (kind === "cargo" || kind === "auto" || kind === "all") {
          const cargo = await callPackage("cargo_check_cmd");
          results.push(`cargo check:\n${cargo.content}`);
        }
        return { ok: true, content: results.length ? results.join("\n\n") : `No diagnostics found for kind: ${kind}` };
      },
    },
    {
      definition: {
        name: "format_files",
        description:
          "Run the project formatter. Uses npm format when present, otherwise cargo fmt. Set check=true to verify without changing where supported.",
        inputSchema: {
          type: "object",
          properties: {
            check: { type: "boolean", description: "Check formatting without writing when supported." },
          },
        },
      },
      async execute(args) {
        const npmFormat = await runNpmScriptIfPresent("format", args.check === true ? ["--check"] : []);
        if (npmFormat) return npmFormat;
        return callPackage("cargo_fmt_cmd", { check: args.check === true });
      },
    },
    {
      definition: {
        name: "lint",
        description:
          "Run static code-quality checks. Uses npm lint when present, otherwise cargo clippy for Rust projects.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        const npmLint = await runNpmScriptIfPresent("lint");
        if (npmLint) return npmLint;
        return callPackage("cargo_clippy_cmd");
      },
    },
    {
      definition: {
        name: "dependency_audit",
        description:
          "Run dependency vulnerability checks. Uses npm audit and cargo audit when available.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", description: "Optional: auto, npm, cargo, or all." },
          },
        },
      },
      async execute(args) {
        const kind = String(args.kind ?? "auto").toLowerCase();
        const results: string[] = [];
        if (kind === "npm" || kind === "auto" || kind === "all") {
          const audit = await callPackage("npm_audit");
          results.push(`npm audit:\n${audit.content}`);
          if (kind === "npm") return audit;
        }
        if (kind === "cargo" || kind === "all") {
          const audit = await callPackage("cargo_audit_cmd");
          results.push(`cargo audit:\n${audit.content}`);
          if (kind === "cargo") return audit;
        }
        return { ok: true, content: results.join("\n\n") || "No audit checks ran." };
      },
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
