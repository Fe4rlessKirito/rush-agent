import type { FsBackend } from "./fsTools";
import type { Tool } from "./tools";

function versionFromCargoToml(content: string): string {
  return content.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "";
}

function jsonVersion(content: string): string {
  try {
    return String((JSON.parse(content) as { version?: unknown }).version ?? "");
  } catch {
    return "";
  }
}

function latestInfo(content: string): { version: string; url: string; signatureLength: number } {
  const parsed = JSON.parse(content) as {
    version?: string;
    platforms?: { "windows-x86_64"?: { url?: string; signature?: string } };
  };
  const win = parsed.platforms?.["windows-x86_64"];
  return {
    version: parsed.version ?? "",
    url: win?.url ?? "",
    signatureLength: win?.signature?.length ?? 0,
  };
}

async function readOptional(fs: FsBackend, path: string): Promise<string> {
  try {
    return await fs.readFile(path);
  } catch {
    return "";
  }
}

export function createReleaseTools(fs: FsBackend): Tool[] {
  return [
    {
      definition: {
        name: "release_prepare",
        description:
          "Read-only release readiness check. Verifies version files, local release artifacts, and updater latest.json metadata.",
        inputSchema: {
          type: "object",
          properties: {
            version: { type: "string", description: "Expected version. Defaults to package.json version." },
          },
        },
      },
      async execute(args) {
        const packageJson = await readOptional(fs, "package.json");
        const packageLock = await readOptional(fs, "package-lock.json");
        const cargoToml = await readOptional(fs, "src-tauri/Cargo.toml");
        const tauriConf = await readOptional(fs, "src-tauri/tauri.conf.json");
        const expected = String(args.version ?? jsonVersion(packageJson)).trim();
        const versions = {
          packageJson: jsonVersion(packageJson),
          packageLock: jsonVersion(packageLock),
          cargoToml: versionFromCargoToml(cargoToml),
          tauriConf: jsonVersion(tauriConf),
        };

        let artifacts: string[] = [];
        try {
          artifacts = await fs.listDir("releases");
        } catch {
          artifacts = [];
        }
        const latestJson = await readOptional(fs, "releases/latest.json");
        const latest = latestJson ? latestInfo(latestJson) : null;
        const expectedSetup = `Rush-Agent-v${expected}-x64-setup.exe`;
        const expectedMsi = `Rush-Agent-v${expected}-x64.msi`;
        const has = (name: string) => artifacts.some((entry) => entry.endsWith(name));

        return {
          ok: true,
          content: [
            `Expected version: ${expected || "(unknown)"}`,
            "Version files:",
            `package.json: ${versions.packageJson || "(missing)"}`,
            `package-lock.json: ${versions.packageLock || "(missing)"}`,
            `src-tauri/Cargo.toml: ${versions.cargoToml || "(missing)"}`,
            `src-tauri/tauri.conf.json: ${versions.tauriConf || "(missing)"}`,
            "",
            "Local artifacts:",
            `${expectedSetup}: ${has(expectedSetup) ? "present" : "missing"}`,
            `${expectedSetup}.sig: ${has(`${expectedSetup}.sig`) ? "present" : "missing"}`,
            `${expectedMsi}: ${has(expectedMsi) ? "present" : "missing"}`,
            `${expectedMsi}.sig: ${has(`${expectedMsi}.sig`) ? "present" : "missing"}`,
            "latest.json:",
            latest
              ? `version=${latest.version}\nurl=${latest.url}\nsignatureLength=${latest.signatureLength}`
              : "missing",
          ].join("\n"),
        };
      },
    },
    {
      definition: {
        name: "release_verify",
        description:
          "Fetch a published latest.json and verify its version, installer URL, and signature length.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Published latest.json URL." },
            version: { type: "string", description: "Optional expected version." },
          },
          required: ["url"],
        },
      },
      async execute(args) {
        const url = String(args.url ?? "").trim();
        if (!/^https?:\/\//i.test(url)) return { ok: false, isError: true, content: `Invalid URL: ${url}` };
        const res = await fetch(url, { headers: { Accept: "application/json,text/plain,*/*" } });
        const text = await res.text();
        if (!res.ok) return { ok: false, isError: true, content: `Fetch ${res.status}: ${text.slice(0, 2000)}` };
        const info = latestInfo(text);
        const expected = String(args.version ?? "").trim();
        return {
          ok: true,
          content: [
            `HTTP: ${res.status}`,
            `version=${info.version}${expected ? ` (${info.version === expected ? "matches" : `expected ${expected}`})` : ""}`,
            `assetUrl=${info.url}`,
            `signatureLength=${info.signatureLength}`,
          ].join("\n"),
        };
      },
    },
  ];
}
