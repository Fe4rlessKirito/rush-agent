import type { Tool } from "./tools";

const GITHUB_API = "https://api.github.com";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function tokenFrom(args: Record<string, unknown>): string {
  return text(args.token) || text((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GITHUB_TOKEN) || text((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GH_TOKEN);
}

function headers(token: string, hasBody = false): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "Rush-Agent",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
  };
}

async function githubRequest(method: string, path: string, args: Record<string, unknown> = {}, body?: unknown): Promise<unknown> {
  const token = tokenFrom(args);
  if (!token) throw new Error("No GitHub token provided. Pass token or set GITHUB_TOKEN/GH_TOKEN in the environment.");
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: headers(token, body !== undefined),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await response.text();
  let parsed: unknown = raw;
  try { parsed = raw ? JSON.parse(raw) : null; } catch { /* keep raw */ }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && "message" in parsed ? String((parsed as { message: unknown }).message) : raw;
    throw new Error(`GitHub ${response.status}: ${message}`);
  }
  return parsed;
}

function repoArg(args: Record<string, unknown>): string {
  const repo = text(args.repo ?? args.repository);
  if (!/^[^/]+\/[^/]+$/.test(repo)) throw new Error("repo must be owner/name.");
  return repo;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function formatJson(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function formatRepo(item: Record<string, unknown>): string {
  return `${item.full_name ?? item.name} ${item.private ? "[private]" : "[public]"}\n${item.description ?? ""}`.trim();
}

function formatIssue(item: Record<string, unknown>): string {
  return `#${item.number} [${item.state}] ${item.title}\n${item.html_url}`;
}

export function createGithubTools(): Tool[] {
  return [
    {
      definition: {
        name: "github_whoami",
        description: "Return the authenticated GitHub user for a token.",
        inputSchema: { type: "object", properties: { token: { type: "string", description: "GitHub token. Optional if GITHUB_TOKEN/GH_TOKEN is set." } } },
      },
      async execute(args) {
        try {
          const user = await githubRequest("GET", "/user", args) as Record<string, unknown>;
          return { ok: true, content: `${user.login}\n${user.html_url}` };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_list_repos",
        description: "List repositories visible to the authenticated GitHub token.",
        inputSchema: { type: "object", properties: { visibility: { type: "string" }, per_page: { type: "number" }, token: { type: "string" } } },
      },
      async execute(args) {
        try {
          const visibility = encodeURIComponent(text(args.visibility) || "all");
          const perPage = numberArg(args.per_page, 30, 1, 100);
          const repos = await githubRequest("GET", `/user/repos?visibility=${visibility}&per_page=${perPage}&sort=updated`, args) as Record<string, unknown>[];
          return { ok: true, content: repos.length ? repos.map(formatRepo).join("\n\n") : "No repositories returned." };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_get_repo",
        description: "Get metadata for a GitHub repository by owner/name.",
        inputSchema: { type: "object", properties: { repo: { type: "string" }, token: { type: "string" } }, required: ["repo"] },
      },
      async execute(args) {
        try {
          return { ok: true, content: formatJson(await githubRequest("GET", `/repos/${repoArg(args)}`, args)) };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_list_branches",
        description: "List branches for a remote GitHub repository without cloning it.",
        inputSchema: { type: "object", properties: { repo: { type: "string" }, token: { type: "string" } }, required: ["repo"] },
      },
      async execute(args) {
        try {
          const branches = await githubRequest("GET", `/repos/${repoArg(args)}/branches`, args) as Record<string, unknown>[];
          return { ok: true, content: branches.map((branch) => String(branch.name)).join("\n") || "No branches returned." };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_get_file",
        description: "Read a file from a remote GitHub repository using the Contents API.",
        inputSchema: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" }, token: { type: "string" } }, required: ["repo", "path"] },
      },
      async execute(args) {
        try {
          const path = text(args.path);
          if (!path) return { ok: false, isError: true, content: "Missing file path." };
          const ref = text(args.ref);
          const file = await githubRequest("GET", `/repos/${repoArg(args)}/contents/${encodePath(path)}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`, args) as Record<string, unknown>;
          const encoded = text(file.content).replace(/\s+/g, "");
          const content = atob(encoded);
          return { ok: true, content };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_put_file",
        description: "Create or update a file in a remote GitHub repository using the Contents API.",
        inputSchema: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" }, content: { type: "string" }, message: { type: "string" }, branch: { type: "string" }, token: { type: "string" } }, required: ["repo", "path", "content", "message"] },
      },
      async execute(args) {
        try {
          const repo = repoArg(args);
          const path = text(args.path);
          const branch = text(args.branch);
          let sha: string | undefined;
          try {
            const existing = await githubRequest("GET", `/repos/${repo}/contents/${encodePath(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`, args) as Record<string, unknown>;
            sha = text(existing.sha) || undefined;
          } catch { /* new file */ }
          const body = {
            message: text(args.message),
            content: btoa(String(args.content ?? "")),
            ...(branch ? { branch } : {}),
            ...(sha ? { sha } : {}),
          };
          const result = await githubRequest("PUT", `/repos/${repo}/contents/${encodePath(path)}`, args, body) as Record<string, unknown>;
          return { ok: true, content: `Updated ${repo}/${path}\n${formatJson(result)}` };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_list_issues",
        description: "List issues for a remote GitHub repository.",
        inputSchema: { type: "object", properties: { repo: { type: "string" }, state: { type: "string" }, token: { type: "string" } }, required: ["repo"] },
      },
      async execute(args) {
        try {
          const state = encodeURIComponent(text(args.state) || "open");
          const issues = await githubRequest("GET", `/repos/${repoArg(args)}/issues?state=${state}`, args) as Record<string, unknown>[];
          return { ok: true, content: issues.length ? issues.map(formatIssue).join("\n\n") : "No issues returned." };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_create_issue",
        description: "Create an issue in a remote GitHub repository.",
        inputSchema: { type: "object", properties: { repo: { type: "string" }, title: { type: "string" }, body: { type: "string" }, token: { type: "string" } }, required: ["repo", "title"] },
      },
      async execute(args) {
        try {
          const issue = await githubRequest("POST", `/repos/${repoArg(args)}/issues`, args, { title: text(args.title), body: text(args.body) }) as Record<string, unknown>;
          return { ok: true, content: formatIssue(issue) };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
    {
      definition: {
        name: "github_search_repos",
        description: "Search GitHub repositories visible to the token.",
        inputSchema: { type: "object", properties: { query: { type: "string" }, per_page: { type: "number" }, token: { type: "string" } }, required: ["query"] },
      },
      async execute(args) {
        try {
          const perPage = numberArg(args.per_page, 10, 1, 50);
          const result = await githubRequest("GET", `/search/repositories?q=${encodeURIComponent(text(args.query))}&per_page=${perPage}`, args) as { items?: Record<string, unknown>[] };
          const repos = result.items ?? [];
          return { ok: true, content: repos.length ? repos.map(formatRepo).join("\n\n") : "No repositories matched." };
        } catch (err) {
          return { ok: false, isError: true, content: String(err) };
        }
      },
    },
  ];
}
