# Rush Agent

Rush Agent is a desktop AI workspace designed for people who want one app for chat, coding help, project work, research, memory, and local model/proxy control.

It combines a ChatGPT-style conversation interface with a Tauri desktop shell, a real filesystem-backed coding workspace, configurable AI providers, a bundled local proxy, and agent tools that can inspect and operate on local projects when the user allows it.

## What Rush Is Designed For

Rush is built to be a local-first AI command center:

- Chat with AI models through OpenAI-compatible, Anthropic-compatible, custom, and local proxy providers.
- Use a code agent that can read, edit, search, run commands, inspect Git state, and work inside selected project folders.
- Keep project context organized with a Projects view, real file tree, editor tabs, terminal output, and project-specific instructions.
- Save and reuse long-term Brain memories so the assistant can remember preferences, facts, workflows, and skills.
- Search saved Library chats and Deep Research runs, then attach them back into the current conversation as context.
- Run Deep Research with configurable free search providers.
- Configure agent tool permissions so risky actions can be allowed, denied, or require confirmation.
- Connect local MCP servers so external tools can be exposed to the agent.
- Manage language-server settings for code intelligence.
- Bundle and auto-launch the Rush local proxy for local API access.

## Main App Areas

### Chat

The Chat interface is for normal AI conversations. It supports:

- Provider and model selection.
- Effort control for thinking depth.
- File and image attachments when the selected provider supports them.
- Library context buttons for adding saved chats or Deep Research reports to the current turn.
- A proxy pool badge showing how many local proxy accounts are warm in the account bank.

### Code Agent

The Code view is for project work. It is designed around a real local workspace, not a fake editor state.

The agent can be configured to use tools for:

- Filesystem reads and writes.
- Git status, diffs, commits, pushes, pulls, and branches.
- Package-manager commands.
- Terminal sessions.
- Background commands.
- Code-aware helpers such as symbol search, definition lookup, references, and rename support.
- Web/search tools where configured.
- MCP-backed tools.

Destructive or sensitive actions can be controlled through the Tools settings.

### Projects

Projects are saved workspaces. They keep project-specific metadata and instructions so each codebase can have its own guidance.

Projects are designed to work similarly to the Library:

- Search and browse saved projects.
- Open a project into the workspace.
- Keep instructions that are fed into the agent system prompt.
- Use the real Tauri filesystem backend when running in the desktop app.

### Library

The Library stores conversations and research outputs so previous work can be searched and reused.

It supports:

- Filtering between chats and Deep Research.
- Searching saved entries.
- Opening saved chats/research reports.
- Adding Library items back into the current chat as context.

### Brain

Brain is the long-term memory panel. It is designed for durable context that should survive across chats.

Brain supports:

- User memories.
- Skills and reusable behavior notes.
- Memory search and sorting.
- Adding memories from the UI or through chat tools.
- Polished controls and compact memory management.

### Deep Research

Deep Research is for multi-step research runs. It uses configured search providers and model reasoning to produce saved research outputs.

Supported search-provider concepts include:

- DuckDuckGo-style free search.
- SearXNG.
- Tavily free-tier API usage.
- Brave Search free-tier API usage.

Research outputs are saved into the Library.

## Local Proxy

Rush can bundle and auto-launch a local proxy on `http://localhost:8000`.

The proxy is designed to expose endpoints such as:

- `POST /v1/chat/completions`
- `POST /v1/messages`
- `POST /v1/chat`
- `POST /chat`
- `POST /v1/chat/with-image`
- `POST /v1/chat/upload-image`
- `POST /v1/chat/with-file`
- `POST /v1/chat/upload-file`
- `GET /v1/models`
- `GET /config`
- `POST /config`
- `GET /bank`
- `GET /health`

Rush includes settings for:

- Enabling or fully disabling proxy auto-launch.
- Pool size.
- Signup delay in milliseconds.
- Account lifetime in seconds.

The chat composer shows the live pool count from `/bank` when the proxy is running.

## Settings

Rush includes settings for:

- Auto updates from GitHub releases.
- Provider configuration.
- Proxy/provider model selection.
- Local proxy startup and account-bank configuration.
- Tool permissions.
- Language-server configuration.
- MCP server configuration.

Tool permissions are designed around practical control:

- Allow tool families.
- Ask before running tool families.
- Deny tool families.
- Restore defaults.

## Safety Model

Rush is designed to keep powerful tools visible and controlled.

The agent can use real local capabilities only where the app wires them in and the user permits them. Destructive or sensitive workflows can be gated through confirmation prompts and settings rules.

Chat mode is intentionally more limited than Code mode. Chat can answer questions and use app context such as Brain and Library, while Code mode is where filesystem, terminal, Git, package-manager, and project tools belong.

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

Run a Tauri build:

```powershell
npm run tauri build
```

For signed release builds, the Tauri updater signing key must be passed as key contents through `TAURI_SIGNING_PRIVATE_KEY`.

## Release Status

Rush Agent is moving toward a stable `1.0.x` desktop release line.

The release process includes:

- Version bumping Node and Tauri metadata.
- Running tests and build checks.
- Building signed Windows installer artifacts.
- Copying installer assets into `releases/`.
- Publishing a GitHub tag and GitHub Release.

Generated release artifacts and build outputs are intentionally kept out of Git.

