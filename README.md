# Rush Agent

Rush is a Windows desktop AI workspace built with Tauri, React, TypeScript, and a bundled Rust local proxy. It is designed for chat, code work, project context, research, memory, and controlled local-agent tooling in one app.

Rush is local-first in the sense that the desktop shell, workspace state, project files, bundled proxy, and tool permissions are managed on the user's machine. Model traffic still goes to whichever provider or local proxy the user configures.

## What Rush Does

Rush combines several workflows that usually live in separate tools:

- **Chat and Code conversations** share one conversation space, so a thread can move between normal chat and project-aware agent work.
- **Project workspaces** connect conversations to a selected local folder, project instructions, file tree, editor panes, terminal output, and Git context.
- **Agent tooling** lets the model inspect files, edit code, search the workspace, run commands, inspect Git, use package-manager helpers, and call MCP tools when enabled.
- **Flow and subagents** let the coordinator delegate focused work to child agents, show those subagent transcripts in the sidebar, and continue subagent threads when useful.
- **Library and Brain** preserve previous chats, research output, and long-term memories so they can be searched and attached back into future turns.
- **Deep Research and Web Probing** provide research-oriented workflows, with Web Probing constrained to passive, defensive checks.
- **Local proxy integration** bundles and launches Rush's Rust proxy for local OpenAI-compatible access.
- **Auto-update support** uses signed Tauri updater artifacts published through GitHub releases.

## Main UI Areas

### Chat and Code

The main conversation panel supports normal assistant conversations and project-aware coding mode. The composer includes:

- Provider and model selection.
- Effort selection for models that support thinking budgets.
- A context-window usage estimate beside the model picker.
- File and image attachments where supported by the selected provider.
- Permission mode controls for tool execution.
- Library context attachment for saved chats and Deep Research reports.
- Project and Git branch context when a workspace is active.

Chat mode is intentionally limited. It can answer questions, use Brain and Library context, and use chat-safe tools. Code mode is where filesystem, terminal, Git, package-manager, project, MCP, and agent tools belong.

### Projects and Workspace

Projects are saved local workspaces. A project can carry its own instructions and root path, and the desktop app can sync that project into the file tree, editor panes, terminal, and code-agent tools.

The code agent is expected to use project-relative paths where possible and to keep tool activity visible in the transcript.

### Flow and Subagents

Flow mode supports planner/worker-style execution and subagents. A coordinator model can spawn focused subagents for investigation, verification, implementation, or parallel work.

Subagents appear as clickable child chats in the sidebar. Selecting one shows its transcript as the main chat view. Users cannot type directly into subagent chats; only the coordinator can continue those child threads through the subagent continuation tool.

Subagent tool activity is kept in the subagent transcript, while the parent coordinator transcript shows only start, follow-up, and finish activity rows.

### Library

The Library stores saved chats and Deep Research output. Library items can be searched and attached back into the current turn as context, instead of forcing the user to manually paste old work.

### Brain

Brain is Rush's long-term memory area. It stores durable user memories, preferences, skills, and reusable notes. Brain context can be surfaced to the assistant when relevant.

### Deep Research

Deep Research runs multi-step research workflows and saves outputs into the Library. Search provider support depends on configuration and may include local/free search options or API-backed providers.

### Web Probing

Web Probing is for authorized, passive, defensive website inspection. It is not a penetration-testing attack runner.

The intended constraints are:

- Use the local proxy path for Web Probing.
- Require user authorization before probing.
- Allow passive inspection and defensive checks.
- Do not run exploit payloads, brute force, credential attacks, DoS/load tests, stealth/evasion, or destructive checks.

### Local Proxy

Rush bundles a Rust local proxy and can auto-launch it with the app. The default local endpoint is:

```text
http://localhost:8000
```

The proxy is used for local provider access and supporting endpoints such as model listing, chat/message routes, health/config routes, and local proxy account-bank status. Exact endpoint support depends on the bundled proxy version.

## Tool Permissions and Safety

Rush exposes powerful local tools only through explicit app wiring and user-configurable permissions. Tool families can be allowed, denied, or set to ask first.

Sensitive or destructive actions should remain visible and gated. Browser automation and website tooling should stay constrained by mode and authorization. Chat mode should not claim access to project files, terminals, Git, package managers, or screen state unless those capabilities are actually available in that mode.

## Providers and Models

Rush supports configurable providers, including OpenAI-compatible providers, Anthropic-style providers, custom endpoints, and the bundled local proxy. Provider settings control model lists, API keys, base URLs, headers, and whether special image/file endpoints are available.

## Updates

Rush uses the Tauri updater with signed artifacts. The app reads its update manifest from the tracked raw GitHub file:

```text
https://raw.githubusercontent.com/Fe4rlessKirito/rush-agent/master/releases/latest.json
```

The installer artifacts themselves are still hosted on GitHub Releases. The manifest must include the Windows fallback platform keys used by the updater, including:

```text
windows-x86_64-nsis
windows-x86_64
windows-x86_64-pc-windows-msvc
```

## Development

Install dependencies:

```powershell
npm install
```

Run the frontend/dev app:

```powershell
npm run dev
```

Run tests:

```powershell
npm test
```

Build the frontend:

```powershell
npm run build
```

Build the desktop app:

```powershell
npm run tauri build
```

For signed release builds, pass the Tauri updater private key through `TAURI_SIGNING_PRIVATE_KEY` and its password through `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Do not commit signing secrets into the repository.

## Release Checklist

A normal Windows release should include:

1. Update the README if behavior changed.
2. Bump versions in `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
3. Run `npm run build`.
4. Run signed `npm run tauri build`.
5. Copy the generated NSIS installer, MSI installer, and both `.sig` files into `releases/`.
6. Update `releases/latest.json` with the new version, release notes, signature, GitHub release URL, and all updater platform fallback keys.
7. Keep `releases/latest.json` CRLF-formatted and verify it parses as JSON.
8. Commit, tag, push, and create the GitHub Release with the installer artifacts.
9. Verify the raw manifest URL returns the expected JSON after pushing.
