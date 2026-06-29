import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_TOOL_PERMISSIONS,
  useAppStore,
  type LanguageServerKey,
  type LanguageServerMode,
} from "../../core/store";
import { useMcpStore, type McpServerConfig, type McpTransport } from "../../core/mcpStore";
import { MCP_PRESETS, missingPresetFields, type McpPreset } from "../../core/mcpPresets";
import type { ProviderConfig } from "../../core/providers/types";
import { createProvider } from "../../core/providers/registry";
import { filterProviderModels, groupModels, modelDisplayName } from "../../core/providers/modelGroups";
import { createMcpConfigTools } from "../../core/agent/mcpRuntime";
import { TOOL_CATALOG, type ToolCatalogItem } from "../../core/agent/toolModes";
import { isTauriRuntime } from "../../core/agent/tauriFs";
import { checkForUpdates, type UpdateCheckResult } from "../../core/updater";
import { useDraggable } from "../hooks/useDraggable";
import { PackManager } from "./PackManager";

type Tab = "general" | "providers" | "proxies" | "tools" | "packs" | "lsp" | "mcp";

// Per-proxy model-list state. Models are fetched lazily the first time a proxy
// is expanded, then cached here so reopening it doesn't re-hit the network.
interface ModelState {
  status: "idle" | "loading" | "ready" | "error";
  models: string[];
  error?: string;
  selected?: string;
}

interface McpDraft {
  id: string;
  label: string;
  transport: McpTransport;
  command: string;
  args: string;
  url: string;
  env: string;
  enabled: boolean;
}

interface LspProbeState {
  status: "idle" | "checking" | "ready" | "missing";
  command?: string;
  source?: string;
  version?: string;
  error?: string;
}

interface LocalProxyStatus {
  enabled: boolean;
  running: boolean;
  ready: boolean;
  error?: string;
}

interface ProxyRuntimeConfig {
  pool_size: number;
  signup_delay_ms: number;
  account_ttl_sec: number;
  proxy_tor: boolean;
  tor_socks?: string;
}

interface TorStatus {
  enabled: boolean;
  auto_start: boolean;
  socks: string;
  socks_reachable: boolean;
  control_port: number;
  control_reachable: boolean;
  control_authenticated: boolean;
  tor_exe?: string | null;
  running: boolean;
  started?: boolean;
  renewed?: boolean;
  error?: string | null;
}

const PROVIDER_ORDER = [
  "anthropic-default",
  "openai-default",
  "deepseek-default",
  "local-proxy",
  "localhost-default",
  "wman-local-proxy",
  "leech-proxy",
  "leech-proxy-openai",
];

function sortProviders(providers: ProviderConfig[]): ProviderConfig[] {
  return providers
    .slice()
    .sort((a, b) => {
      const ai = PROVIDER_ORDER.indexOf(a.id);
      const bi = PROVIDER_ORDER.indexOf(b.id);
      if (ai !== -1 || bi !== -1) {
        return (ai === -1 ? Number.MAX_SAFE_INTEGER : ai) - (bi === -1 ? Number.MAX_SAFE_INTEGER : bi);
      }
      return a.label.localeCompare(b.label);
    });
}

function emptyMcpDraft(): McpDraft {
  return {
    id: "",
    label: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    env: "",
    enabled: true,
  };
}

function mcpDraftFromServer(server: McpServerConfig): McpDraft {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command ?? "",
    args: server.args?.map(quoteArg).join(" ") ?? "",
    url: server.url ?? "",
    env: Object.entries(server.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"),
    enabled: server.enabled,
  };
}

function splitCommandArgs(value: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "\"" || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (/\s/.test(char) && !quote) {
      if (current) args.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) args.push(current);
  return args;
}

function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replace(/"/g, "\\\"")}"` : value;
}

function parseEnv(value: string): Record<string, string> {
  return Object.fromEntries(
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const index = line.indexOf("=");
        return index === -1
          ? [line, ""]
          : [line.slice(0, index).trim(), line.slice(index + 1).trim()];
      })
      .filter(([key]) => key),
  );
}

function mcpConfigFromDraft(draft: McpDraft): McpServerConfig {
  const id = draft.id.trim() || draft.label.trim() || draft.command.trim() || "mcp-server";
  return {
    id,
    label: draft.label.trim() || id,
    transport: draft.transport,
    enabled: draft.enabled,
    command: draft.command.trim() || undefined,
    args: splitCommandArgs(draft.args),
    url: draft.url.trim() || undefined,
    env: parseEnv(draft.env),
  };
}

export function SettingsPanel({ onClose, initialTab = "general" }: { onClose: () => void; initialTab?: Tab }) {
  const {
    providers,
    upsertProvider,
    setActive,
    activeProviderId,
    activeModel,
    autoUpdateEnabled,
    setAutoUpdateEnabled,
    toolPermissions,
    setToolPermissions,
    languageServerSettings,
    setLanguageServerConfig,
  } = useAppStore();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [draft, setDraft] = useState<Record<string, ProviderConfig>>(
    Object.fromEntries(providers.map((p) => [p.id, p])),
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modelState, setModelState] = useState<Record<string, ModelState>>({});
  const [updateState, setUpdateState] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [dirtyProviders, setDirtyProviders] = useState<Set<string>>(() => new Set());
  const [savedProviderId, setSavedProviderId] = useState<string | null>(null);
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(() => emptyMcpDraft());
  const [mcpBusyId, setMcpBusyId] = useState<string | null>(null);
  const [mcpMessage, setMcpMessage] = useState<string | null>(null);
  const [mcpPresetValues, setMcpPresetValues] = useState<Record<string, Record<string, string>>>({});
  const [toolSearch, setToolSearch] = useState("");
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null);
  const [toolFeedback, setToolFeedback] = useState("");
  const [localProxyEnabled, setLocalProxyEnabled] = useState(true);
  const [localProxyStatus, setLocalProxyStatus] = useState<LocalProxyStatus | null>(null);
  const [localProxyBusy, setLocalProxyBusy] = useState(false);
  const [proxyConfig, setProxyConfig] = useState<ProxyRuntimeConfig>({
    pool_size: 30,
    signup_delay_ms: 0,
    account_ttl_sec: 1800,
    proxy_tor: false,
  });
  const [proxyConfigBusy, setProxyConfigBusy] = useState(false);
  const [proxyConfigMessage, setProxyConfigMessage] = useState("");
  const [torStatus, setTorStatus] = useState<TorStatus | null>(null);
  const [torBusy, setTorBusy] = useState(false);
  const [torMessage, setTorMessage] = useState("");
  const [lspProbe, setLspProbe] = useState<Record<LanguageServerKey, LspProbeState>>({
    rust: { status: "idle" },
    typescript: { status: "idle" },
  });
  const [lspInstallJobs, setLspInstallJobs] = useState<Partial<Record<LanguageServerKey, string>>>({});
  const { onMouseDown, style } = useDraggable();
  const orderedProviders = sortProviders(providers);
  const mcpServers = useMcpStore((s) => s.servers);
  const mcpStatuses = useMcpStore((s) => s.statuses);
  const mcpErrors = useMcpStore((s) => s.errors);
  const mcpResources = useMcpStore((s) => s.resources);
  const mcpTools = useMcpStore((s) => s.deferredTools);
  const mcpActions = useMemo(
    () => new Map(createMcpConfigTools().map((tool) => [tool.definition.name, tool])),
    [],
  );

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  function edit(id: string, patch: Partial<ProviderConfig>) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
    setDirtyProviders((ids) => new Set(ids).add(id));
    setSavedProviderId((savedId) => (savedId === id ? null : savedId));
  }

  useEffect(() => {
    setDraft((current) => {
      const next = { ...current };
      for (const p of providers) {
        if (!dirtyProviders.has(p.id)) next[p.id] = p;
      }
      return next;
    });
  }, [providers, dirtyProviders]);

  useEffect(() => {
    if (!savedProviderId) return;
    const timer = setTimeout(() => setSavedProviderId(null), 1600);
    return () => clearTimeout(timer);
  }, [savedProviderId]);

  useEffect(() => {
    if (!toolFeedback) return;
    const timer = setTimeout(() => setToolFeedback(""), 1400);
    return () => clearTimeout(timer);
  }, [toolFeedback]);

  useEffect(() => {
    if (!proxyConfigMessage || proxyConfigMessage.startsWith("Unable")) return;
    const timer = setTimeout(() => setProxyConfigMessage(""), 1800);
    return () => clearTimeout(timer);
  }, [proxyConfigMessage]);

  useEffect(() => {
    if (!isTauriRuntime()) return;
    let cancelled = false;
    invoke<LocalProxyStatus>("local_proxy_status")
      .then((status) => {
        if (cancelled) return;
        setLocalProxyStatus(status);
        setLocalProxyEnabled(status.enabled);
        if (status.enabled) {
          void refreshProxyConfig();
          void refreshTorStatus();
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setLocalProxyStatus({
            enabled: true,
            running: false,
            ready: false,
            error: String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleToolCatalog = useMemo(() => {
    const q = toolSearch.trim().toLowerCase();
    if (!q) return TOOL_CATALOG;
    return TOOL_CATALOG.filter((item) =>
      [
        item.label,
        item.category,
        item.description,
        ...item.tools,
      ].some((value) => value.toLowerCase().includes(q)),
    );
  }, [toolSearch]);

  function ruleToolName(rule: string): string {
    return rule.trim().match(/^([A-Za-z][A-Za-z0-9_]*)/)?.[1] ?? rule.trim();
  }

  function rulesWithoutToolFamily(rules: string[] | undefined, item: ToolCatalogItem): string[] {
    const names = new Set(item.tools);
    return (rules ?? []).filter((rule) => !names.has(ruleToolName(rule)));
  }

  function toolEffectEnabled(item: ToolCatalogItem, effect: "allow" | "ask" | "deny"): boolean {
    const rules = new Set(toolPermissions[effect] ?? []);
    return item.tools.every((tool) => rules.has(tool));
  }

  function toolEffectPartial(item: ToolCatalogItem, effect: "allow" | "ask" | "deny"): boolean {
    const rules = new Set(toolPermissions[effect] ?? []);
    const count = item.tools.filter((tool) => rules.has(tool)).length;
    return count > 0 && count < item.tools.length;
  }

  function toolEffectLabel(item: ToolCatalogItem): string {
    if (toolEffectEnabled(item, "deny")) return "Denied";
    if (toolEffectEnabled(item, "ask")) return "Ask";
    if (toolEffectEnabled(item, "allow")) return "Allowed";
    if (
      toolEffectPartial(item, "deny") ||
      toolEffectPartial(item, "ask") ||
      toolEffectPartial(item, "allow")
    ) return "Mixed";
    return "Default";
  }

  function applyToolPermissions(next: typeof toolPermissions, message: string) {
    setToolPermissions(next);
    setToolFeedback(message);
  }

  async function refreshProxyConfig() {
    setProxyConfigBusy(true);
    try {
      const res = await fetch("http://localhost:8000/config", { cache: "no-store" });
      if (!res.ok) throw new Error(`config ${res.status}`);
      const config = (await res.json()) as ProxyRuntimeConfig;
      setProxyConfig(config);
      setProxyConfigMessage("Loaded proxy config");
    } catch (err) {
      setProxyConfigMessage(`Unable to load proxy config: ${String(err)}`);
    } finally {
      setProxyConfigBusy(false);
    }
  }

  async function saveProxyConfig() {
    setProxyConfigBusy(true);
    try {
      const body: ProxyRuntimeConfig = {
        pool_size: Math.min(20000, Math.max(1, Math.round(proxyConfig.pool_size))),
        signup_delay_ms: Math.max(0, Math.round(proxyConfig.signup_delay_ms)),
        account_ttl_sec: Math.max(60, Math.round(proxyConfig.account_ttl_sec)),
        proxy_tor: Boolean(proxyConfig.proxy_tor),
      };
      const res = await fetch("http://localhost:8000/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`config ${res.status}`);
      setProxyConfig(body);
      setProxyConfigMessage("Saved proxy config");
      void refreshTorStatus();
    } catch (err) {
      setProxyConfigMessage(`Unable to save proxy config: ${String(err)}`);
    } finally {
      setProxyConfigBusy(false);
    }
  }

  function editProxyConfig(key: "pool_size" | "signup_delay_ms" | "account_ttl_sec", value: number) {
    setProxyConfig((config) => ({ ...config, [key]: value }));
  }

  function setProxyTor(enabled: boolean) {
    setProxyConfig((config) => ({ ...config, proxy_tor: enabled }));
  }

  async function refreshTorStatus() {
    setTorBusy(true);
    try {
      const res = await fetch("http://localhost:8000/tor/status", { cache: "no-store" });
      if (!res.ok) throw new Error(`tor status ${res.status}`);
      const status = (await res.json()) as TorStatus;
      setTorStatus(status);
      setTorMessage("");
    } catch (err) {
      setTorMessage(`Unable to load Tor status: ${String(err)}`);
    } finally {
      setTorBusy(false);
    }
  }

  async function startTor() {
    setTorBusy(true);
    try {
      const res = await fetch("http://localhost:8000/tor/start", { method: "POST" });
      const status = (await res.json()) as TorStatus;
      setTorStatus(status);
      if (!res.ok) throw new Error(status.error ?? `tor start ${res.status}`);
      setTorMessage("Tor started");
    } catch (err) {
      setTorMessage(`Unable to start Tor: ${String(err)}`);
    } finally {
      setTorBusy(false);
    }
  }

  async function renewTorCircuit() {
    setTorBusy(true);
    try {
      const res = await fetch("http://localhost:8000/tor/newnym", { method: "POST" });
      const status = (await res.json()) as TorStatus;
      setTorStatus(status);
      if (!res.ok) throw new Error(status.error ?? `tor newnym ${res.status}`);
      setTorMessage("Requested a new Tor circuit");
    } catch (err) {
      setTorMessage(`Unable to renew Tor circuit: ${String(err)}`);
    } finally {
      setTorBusy(false);
    }
  }

  async function toggleLocalProxy(enabled: boolean) {
    setLocalProxyEnabled(enabled);
    if (!isTauriRuntime()) return;
    setLocalProxyBusy(true);
    try {
      const status = await invoke<LocalProxyStatus>("local_proxy_set_enabled", { enabled });
      setLocalProxyStatus(status);
      setLocalProxyEnabled(status.enabled);
      if (status.enabled) {
        void refreshProxyConfig();
        void refreshTorStatus();
      }
    } catch (err) {
      setLocalProxyEnabled((current) => !current);
      setLocalProxyStatus({
        enabled: !enabled,
        running: false,
        ready: false,
        error: String(err),
      });
    } finally {
      setLocalProxyBusy(false);
    }
  }

  function setToolEffect(item: ToolCatalogItem, effect: "allow" | "ask" | "deny", enabled: boolean) {
    const next = {
      allow: rulesWithoutToolFamily(toolPermissions.allow, item),
      ask: rulesWithoutToolFamily(toolPermissions.ask, item),
      deny: rulesWithoutToolFamily(toolPermissions.deny, item),
    };
    if (enabled) {
      next[effect] = [...next[effect], ...item.tools];
    }
    applyToolPermissions(next, enabled ? `${item.label}: ${effect}` : `${item.label}: default`);
  }

  function saveProvider(config: ProviderConfig, activate = false) {
    const saved = {
      ...config,
      baseUrl: config.baseUrl.trim(),
      apiKey: config.apiKey?.trim() || undefined,
      defaultModel: config.defaultModel.trim(),
      enabled: true,
    };

    upsertProvider(saved);
    setDraft((d) => ({ ...d, [saved.id]: saved }));
    setDirtyProviders((ids) => {
      const next = new Set(ids);
      next.delete(saved.id);
      return next;
    });
    setSavedProviderId(saved.id);
    if (activate || activeProviderId === saved.id) {
      setActive(saved.id, saved.defaultModel);
    }
  }

  // Toggle a proxy open/closed. On first open, fetch its model list through a
  // live Provider built from the saved config.
  async function toggleProxy(p: ProviderConfig) {
    if (expanded === p.id) {
      setExpanded(null);
      return;
    }
    setExpanded(p.id);
    const existing = modelState[p.id];
    if (existing && (existing.status === "ready" || existing.status === "loading")) return;

    setModelState((s) => ({ ...s, [p.id]: { status: "loading", models: [] } }));
    try {
      const models = filterProviderModels(p.id, await createProvider(p).listModels());
      const selected = models.includes(p.defaultModel) ? p.defaultModel : models[0];
      setModelState((s) => ({
        ...s,
        [p.id]: { status: "ready", models, selected },
      }));
    } catch (err) {
      setModelState((s) => ({
        ...s,
        [p.id]: { status: "error", models: [], error: String(err) },
      }));
    }
  }

  function refresh(p: ProviderConfig) {
    setModelState((s) => {
      const next = { ...s };
      delete next[p.id];
      return next;
    });
    setExpanded(null);
    // Re-open on next tick so toggleProxy re-fetches.
    setTimeout(() => toggleProxy(p), 0);
  }

  async function checkNow() {
    setCheckingUpdate(true);
    setUpdateState(null);
    const result = await checkForUpdates(true);
    setUpdateState(result);
    setCheckingUpdate(false);
  }

  async function runMcpTool(name: string, args: object, busyId: string) {
    const tool = mcpActions.get(name);
    if (!tool) return;
    setMcpBusyId(busyId);
    setMcpMessage(null);
    try {
      const result = await tool.execute(args as Record<string, unknown>);
      setMcpMessage(result.content);
    } catch (err) {
      setMcpMessage(String(err));
    } finally {
      setMcpBusyId(null);
    }
  }

  function lspArgs(language: LanguageServerKey) {
    const config = languageServerSettings[language];
    return {
      language,
      binaryPath: config.mode === "custom" ? config.customPath : undefined,
      preferBundled: config.mode === "bundled",
    };
  }

  async function probeLanguageServer(language: LanguageServerKey) {
    setLspProbe((s) => ({ ...s, [language]: { status: "checking" } }));
    try {
      const result = await invoke<{
        available: boolean;
        command: string;
        source: string;
        version?: string;
        error?: string;
      }>("lsp_probe", lspArgs(language));
      setLspProbe((s) => ({
        ...s,
        [language]: {
          status: result.available ? "ready" : "missing",
          command: result.command,
          source: result.source,
          version: result.version,
          error: result.error,
        },
      }));
    } catch (err) {
      setLspProbe((s) => ({
        ...s,
        [language]: { status: "missing", error: String(err) },
      }));
    }
  }

  async function installLanguageServer(language: LanguageServerKey) {
    const command = language === "typescript"
      ? "npm install -g typescript-language-server typescript"
      : "rustup component add rust-analyzer";
    const ok = window.confirm(`Run this install/update command?\n\n${command}`);
    if (!ok) return;
    try {
      const result = await invoke<{ id: string }>("background_start", {
        command,
        shell: "powershell",
      });
      setLspInstallJobs((jobs) => ({ ...jobs, [language]: result.id }));
    } catch (err) {
      setLspProbe((s) => ({
        ...s,
        [language]: { status: "missing", error: String(err) },
      }));
    }
  }

  async function saveMcpServer() {
    const config = mcpConfigFromDraft(mcpDraft);
    await runMcpTool("McpServerConfigure", config, "save");
    setMcpDraft(mcpDraftFromServer(config));
  }

  function presetValues(id: string): Record<string, string> {
    return mcpPresetValues[id] ?? {};
  }

  function setPresetValue(presetId: string, key: string, value: string) {
    setMcpPresetValues((state) => ({
      ...state,
      [presetId]: {
        ...(state[presetId] ?? {}),
        [key]: value,
      },
    }));
  }

  async function applyMcpPreset(preset: McpPreset, connect: boolean) {
    const values = presetValues(preset.id);
    const missing = missingPresetFields(preset, values);
    if (missing.length > 0) {
      setMcpMessage(`Missing required preset field${missing.length === 1 ? "" : "s"}: ${missing.map((field) => field.label).join(", ")}`);
      return;
    }
    const config = preset.buildConfig(values);
    await runMcpTool("McpServerConfigure", config, `preset:${preset.id}`);
    setMcpDraft(mcpDraftFromServer(config));
    if (connect && config.transport === "stdio") {
      await runMcpTool("McpServerConnect", { id: config.id }, `connect:${config.id}`);
    }
  }

  async function connectMcpServer(id: string) {
    await runMcpTool("McpServerConnect", { id }, `connect:${id}`);
  }

  async function disconnectMcpServer(id: string) {
    await runMcpTool("McpServerDisconnect", { id }, `disconnect:${id}`);
  }

  async function removeMcpServer(id: string) {
    await runMcpTool("McpServerRemove", { id }, `remove:${id}`);
    setMcpDraft((draft) => (draft.id === id ? emptyMcpDraft() : draft));
  }

  return (
    <div className="settings-overlay" onMouseDown={onClose}>
      <div
        className="settings-panel"
        style={style}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-header" onMouseDown={onMouseDown}>
          <span className="settings-title">Settings</span>
          <button className="settings-close" onClick={onClose} aria-label="Close settings">
            ✕
          </button>
        </div>

        <div className="settings-tabs">
          <button
            className={`settings-tab ${tab === "general" ? "active" : ""}`}
            onClick={() => setTab("general")}
          >
            General
          </button>
          <button
            className={`settings-tab ${tab === "providers" ? "active" : ""}`}
            onClick={() => setTab("providers")}
          >
            Providers
          </button>
          <button
            className={`settings-tab ${tab === "proxies" ? "active" : ""}`}
            onClick={() => setTab("proxies")}
          >
            Proxies
          </button>
          <button
            className={`settings-tab ${tab === "tools" ? "active" : ""}`}
            onClick={() => setTab("tools")}
          >
            Tools
          </button>
          <button
            className={`settings-tab ${tab === "packs" ? "active" : ""}`}
            onClick={() => setTab("packs")}
          >
            Packs
          </button>
          <button
            className={`settings-tab ${tab === "lsp" ? "active" : ""}`}
            onClick={() => setTab("lsp")}
          >
            LSP
          </button>
          <button
            className={`settings-tab ${tab === "mcp" ? "active" : ""}`}
            onClick={() => setTab("mcp")}
          >
            MCP
          </button>
        </div>

        {tab === "general" ? (
          <div className="settings-body">
            <div className="settings-section">
              <div>
                <h3>Updates</h3>
                <p className="hint">GitHub release updates</p>
              </div>
              <label className="toggle-row">
                <span>
                  <strong>Auto update</strong>
                  <small>{autoUpdateEnabled ? "On" : "Off"}</small>
                </span>
                <input
                  type="checkbox"
                  checked={autoUpdateEnabled}
                  onChange={(e) => setAutoUpdateEnabled(e.target.checked)}
                />
              </label>
              <div className="row">
                <button onClick={checkNow} disabled={checkingUpdate}>
                  {checkingUpdate ? "Checking..." : "Check now"}
                </button>
                {updateState && (
                  <span className={`update-status ${updateState.status}`}>
                    {updateState.message}
                  </span>
                )}
              </div>
            </div>
            <div className="settings-section">
              <div>
                <h3>Local proxy</h3>
                <p className="hint">Launch and monitor the bundled Rush proxy.</p>
              </div>
              <label className="toggle-row">
                <span>
                  <strong>Auto launch proxy</strong>
                  <small>
                    {localProxyBusy
                      ? "Updating..."
                      : localProxyEnabled
                        ? localProxyStatus?.ready
                          ? "On, ready"
                          : localProxyStatus?.running
                            ? "On, starting"
                            : "On"
                        : "Off"}
                  </small>
                </span>
                <input
                  type="checkbox"
                  checked={localProxyEnabled}
                  disabled={localProxyBusy}
                  onChange={(e) => toggleLocalProxy(e.target.checked)}
                />
              </label>
              {localProxyStatus?.error && (
                <p className="hint error">{localProxyStatus.error}</p>
              )}
              <div className="proxy-config-panel">
                <div className="proxy-config-head">
                  <div>
                    <strong>Tor routing</strong>
                    <span>Outbound signup, file upload, and WebSocket traffic</span>
                  </div>
                  <button
                    className="ghost small"
                    onClick={refreshTorStatus}
                    disabled={!localProxyEnabled || torBusy}
                  >
                    Refresh
                  </button>
                </div>

                <label className="toggle-row">
                  <span>
                    <strong>Route through Tor</strong>
                    <small>
                      {proxyConfig.proxy_tor
                        ? torStatus?.running
                          ? `On, ${torStatus.socks}`
                          : "On, not connected"
                        : "Off"}
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={proxyConfig.proxy_tor}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => setProxyTor(e.target.checked)}
                  />
                </label>

                <div className={`tor-status-card ${torStatus?.running ? "ready" : "offline"}`}>
                  <div>
                    <span className="tor-status-dot" aria-hidden="true" />
                    <strong>{torStatus?.running ? "Tor connected" : "Tor unavailable"}</strong>
                  </div>
                  <dl>
                    <dt>SOCKS</dt>
                    <dd>{torStatus?.socks ?? proxyConfig.tor_socks ?? "socks5h://127.0.0.1:9050"}</dd>
                    <dt>Control</dt>
                    <dd>{torStatus?.control_authenticated ? `Authenticated on ${torStatus.control_port}` : "Not authenticated"}</dd>
                    <dt>Binary</dt>
                    <dd>{torStatus?.tor_exe ?? "Not found"}</dd>
                  </dl>
                  {torStatus?.error && <p className="hint error">{torStatus.error}</p>}
                  {torMessage && <p className={`proxy-config-message ${torMessage.startsWith("Unable") ? "error" : ""}`}>{torMessage}</p>}
                  <div className="row">
                    <button
                      className="ghost small"
                      onClick={startTor}
                      disabled={!localProxyEnabled || torBusy || !proxyConfig.proxy_tor}
                    >
                      {torBusy ? "Working..." : "Start Tor"}
                    </button>
                    <button
                      className="ghost small"
                      onClick={renewTorCircuit}
                      disabled={!localProxyEnabled || torBusy || !proxyConfig.proxy_tor || !torStatus?.control_authenticated}
                    >
                      New circuit
                    </button>
                  </div>
                </div>

                <div className="proxy-config-head">
                  <div>
                    <strong>Account bank</strong>
                    <span>Live proxy config from <code>/config</code></span>
                  </div>
                  <button
                    className="ghost small"
                    onClick={refreshProxyConfig}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                  >
                    Refresh
                  </button>
                </div>

                <label className="proxy-config-row">
                  <span>
                    <strong>Pool size</strong>
                    <small>Warm accounts kept ready. Higher values use more RAM.</small>
                  </span>
                  <input
                    type="range"
                    min="1"
                    max="20000"
                    step="1"
                    value={proxyConfig.pool_size}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => editProxyConfig("pool_size", Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min="1"
                    max="20000"
                    value={proxyConfig.pool_size}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => editProxyConfig("pool_size", Number(e.target.value))}
                  />
                </label>
                <p className="proxy-config-warning">
                  Large pools can consume a lot of memory because every warm account has runtime state.
                </p>

                <label className="proxy-config-row">
                  <span>
                    <strong>Signup delay</strong>
                    <small>Milliseconds between account creation</small>
                  </span>
                  <input
                    type="range"
                    min="0"
                    max="10000"
                    step="100"
                    value={proxyConfig.signup_delay_ms}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => editProxyConfig("signup_delay_ms", Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min="0"
                    step="100"
                    value={proxyConfig.signup_delay_ms}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => editProxyConfig("signup_delay_ms", Number(e.target.value))}
                  />
                </label>

                <label className="proxy-config-row">
                  <span>
                    <strong>Account lifetime</strong>
                    <small>Seconds before rotating bank accounts</small>
                  </span>
                  <input
                    type="range"
                    min="60"
                    max="7200"
                    step="60"
                    value={proxyConfig.account_ttl_sec}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => editProxyConfig("account_ttl_sec", Number(e.target.value))}
                  />
                  <input
                    type="number"
                    min="60"
                    step="60"
                    value={proxyConfig.account_ttl_sec}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                    onChange={(e) => editProxyConfig("account_ttl_sec", Number(e.target.value))}
                  />
                </label>

                <div className="row">
                  <button
                    onClick={saveProxyConfig}
                    disabled={!localProxyEnabled || proxyConfigBusy}
                  >
                    {proxyConfigBusy ? "Saving..." : "Save bank settings"}
                  </button>
                  {proxyConfigMessage && (
                    <span className={`proxy-config-message ${proxyConfigMessage.startsWith("Unable") ? "error" : ""}`}>
                      {proxyConfigMessage}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>
        ) : tab === "providers" ? (
          <div className="settings-body">
            <p className="hint">
              Standard vendors and custom proxies share the same form. A proxy is just a
              custom base URL + optional key + headers.
            </p>
            <div className="provider-grid">
              {orderedProviders.map((p) => {
                const d = draft[p.id] ?? p;
                const isActive = activeProviderId === p.id;
                return (
                  <div className="provider-card" key={p.id}>
                    <div className="row">
                      <strong>{d.label}</strong>
                      <span className="tag">{d.kind}</span>
                      {isActive && <span className="tag active">active</span>}
                    </div>
                    <label>Base URL
                      <input value={d.baseUrl} onChange={(e) => edit(p.id, { baseUrl: e.target.value })} />
                    </label>
                    <label>API Key
                      <input type="password" value={d.apiKey ?? ""} onChange={(e) => edit(p.id, { apiKey: e.target.value })} />
                    </label>
                    <label>Model
                      <input value={d.defaultModel} onChange={(e) => edit(p.id, { defaultModel: e.target.value })} />
                    </label>
                    <div className="provider-capabilities">
                      <label className="toggle-row">
                        <span>
                          <strong>Thinking</strong>
                          <small>Send WMan-style thinking options to this provider.</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={Boolean(d.supportsThinking)}
                          onChange={(e) => edit(p.id, { supportsThinking: e.target.checked })}
                        />
                      </label>
                      <label className="toggle-row">
                        <span>
                          <strong>Image endpoint</strong>
                          <small>Use /chat/with-image for attached images.</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={Boolean(d.supportsImageChatEndpoint)}
                          onChange={(e) => edit(p.id, { supportsImageChatEndpoint: e.target.checked })}
                        />
                      </label>
                      <label className="toggle-row">
                        <span>
                          <strong>File endpoint</strong>
                          <small>Use /chat/upload-file for non-image attachments.</small>
                        </span>
                        <input
                          type="checkbox"
                          checked={Boolean(d.supportsFileChatEndpoint)}
                          onChange={(e) => edit(p.id, { supportsFileChatEndpoint: e.target.checked })}
                        />
                      </label>
                    </div>
                    <div className="row">
                      <button onClick={() => saveProvider(d)}>
                        {savedProviderId === p.id ? "Saved" : "Save"}
                      </button>
                      <button className="ghost" onClick={() => saveProvider(d, true)}>
                        Use this
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="hint">
              Active: {activeProviderId ? `${activeProviderId} / ${activeModel}` : "none selected"}
            </p>
          </div>
        ) : tab === "proxies" ? (
          <div className="settings-body">
            <p className="hint">
              Saved proxies. Click one to load the models it offers, then pick a model
              to make it active.
            </p>
            <div className="proxy-list">
              {orderedProviders.map((p) => {
                const ms = modelState[p.id];
                const visibleModels = ms ? filterProviderModels(p.id, ms.models) : [];
                const selected = ms?.selected && visibleModels.includes(ms.selected) ? ms.selected : visibleModels[0];
                const isOpen = expanded === p.id;
                const isActive = activeProviderId === p.id;
                return (
                  <div className={`proxy-item ${isOpen ? "open" : ""}`} key={p.id}>
                    <button className="proxy-head" onClick={() => toggleProxy(p)}>
                      <span className={`caret ${isOpen ? "down" : ""}`}>▸</span>
                      <strong>{p.label}</strong>
                      <span className="tag">{p.kind}</span>
                      {isActive && <span className="tag active">active</span>}
                      <span className="proxy-url">{p.baseUrl}</span>
                    </button>

                    {isOpen && (
                      <div className="proxy-body">
                        {ms?.status === "loading" && <p className="hint">Loading models…</p>}
                        {ms?.status === "error" && (
                          <p className="hint error">
                            Couldn't load models: {ms.error}
                            <button className="ghost small" onClick={() => refresh(p)}>Retry</button>
                          </p>
                        )}
                        {ms?.status === "ready" && (
                          visibleModels.length === 0 ? (
                            <p className="hint">This proxy returned no models.</p>
                          ) : (
                            <div className="row">
                              <select
                                value={selected}
                                onChange={(e) =>
                                  setModelState((s) => ({
                                    ...s,
                                    [p.id]: { ...s[p.id], selected: e.target.value },
                                  }))
                                }
                              >
                                {groupModels(visibleModels).map((group) => (
                                  <optgroup key={group.label} label={group.label}>
                                    {group.models.map((m) => (
                                      <option key={m} value={m}>{modelDisplayName(m)}</option>
                                    ))}
                                  </optgroup>
                                ))}
                              </select>
                              <button
                                onClick={() => {
                                  if (!selected) return;
                                  const saved = {
                                    ...p,
                                    defaultModel: selected,
                                    enabled: true,
                                  };
                                  upsertProvider(saved);
                                  setDraft((d) => ({ ...d, [saved.id]: saved }));
                                  setActive(p.id, selected);
                                }}
                                disabled={!selected}
                              >
                                Use
                              </button>
                              <button className="ghost small" onClick={() => refresh(p)}>Refresh</button>
                            </div>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className="hint">
              Active: {activeProviderId ? `${activeProviderId} / ${activeModel}` : "none selected"}
            </p>
          </div>
        ) : tab === "tools" ? (
          <div className="settings-body">
            <div className="tool-settings-head">
              <label className="tool-search">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M16.5 16.5 21 21" />
                </svg>
                <input
                  value={toolSearch}
                  onChange={(e) => setToolSearch(e.target.value)}
                  placeholder="Search tools..."
                />
              </label>
              <button
                className="ghost"
                onClick={() => applyToolPermissions(DEFAULT_TOOL_PERMISSIONS, "Defaults restored")}
              >
                Reset defaults
              </button>
              {toolFeedback && <span className="tool-feedback">{toolFeedback}</span>}
            </div>
            <p className="hint">
              Open a tool family to choose whether Rush should allow it, ask first, or deny it.
            </p>
            <details className="tool-rule-summary">
              <summary>
                <span>Active rules</span>
                <code>{toolPermissions.allow?.length ?? 0} allow</code>
                <code>{toolPermissions.ask?.length ?? 0} ask</code>
                <code>{toolPermissions.deny?.length ?? 0} deny</code>
              </summary>
              <div>
                {([
                  ["Allow", toolPermissions.allow ?? []],
                  ["Ask", toolPermissions.ask ?? []],
                  ["Deny", toolPermissions.deny ?? []],
                ] as const).map(([label, rules]) => (
                  <section key={label}>
                    <strong>{label}</strong>
                    {rules.length > 0 ? (
                      <span>{rules.join(", ")}</span>
                    ) : (
                      <span className="empty">None</span>
                    )}
                  </section>
                ))}
              </div>
            </details>
            <div className="tool-toggle-list">
              {visibleToolCatalog.length > 0 ? visibleToolCatalog.map((item) => {
                const expanded = expandedToolId === item.id;
                return (
                  <div className={`tool-toggle-item ${expanded ? "open" : ""}`} key={item.id}>
                    <button
                      className="tool-toggle-row"
                      onClick={() => setExpandedToolId((id) => id === item.id ? null : item.id)}
                      aria-expanded={expanded}
                    >
                      <span className="tool-toggle-main">
                        <span>
                          <strong>{item.label}</strong>
                          <small>{item.description}</small>
                        </span>
                        <span className="tool-toggle-meta">
                          <span>{item.category}</span>
                          <code>{item.tools.join(", ")}</code>
                        </span>
                      </span>
                      <span className={`tool-effect-pill ${toolEffectLabel(item).toLowerCase()}`}>
                        {toolEffectLabel(item)}
                      </span>
                      <span className={`tool-row-caret ${expanded ? "open" : ""}`}>▸</span>
                    </button>
                    {expanded && (
                      <div className="tool-effect-panel">
                        {([
                          ["allow", "Allow", "Run without extra confirmation when no narrower rule blocks it."],
                          ["ask", "Ask", "Always confirm before this tool family runs."],
                          ["deny", "Deny", "Block this tool family completely."],
                        ] as const).map(([effect, label, description]) => (
                          <label className={`tool-effect-slider ${effect}`} key={effect}>
                            <span>
                              <strong>{label}</strong>
                              <small>{description}</small>
                            </span>
                            <input
                              type="checkbox"
                              checked={toolEffectEnabled(item, effect)}
                              onChange={(e) => setToolEffect(item, effect, e.target.checked)}
                              aria-label={`${label} ${item.label}`}
                            />
                          </label>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }) : (
                <div className="tool-toggle-empty">No tools match this search.</div>
              )}
            </div>
          </div>
        ) : tab === "packs" ? (
          <PackManager />
        ) : tab === "lsp" ? (
          <div className="settings-body">
            <p className="hint">
              Configure language servers for code intelligence. Rush can use PATH,
              a bundled binary when one exists beside the app, or a custom executable path.
            </p>
            <div className="lsp-settings-list">
              {([
                ["rust", "Rust", "rust-analyzer", "Used for Rust definitions, references, and rename previews."],
                ["typescript", "TypeScript / JavaScript", "typescript-language-server", "Used for TS, TSX, JS, and JSX code intelligence."],
              ] as const).map(([language, label, binary, description]) => {
                const config = languageServerSettings[language];
                const probe = lspProbe[language];
                return (
                  <section className={`lsp-card ${probe.status}`} key={language}>
                    <div className="lsp-card-head">
                      <div>
                        <strong>{label}</strong>
                        <span>{description}</span>
                      </div>
                      <span className={`lsp-status ${probe.status}`}>
                        {probe.status === "checking"
                          ? "Checking"
                          : probe.status === "ready"
                            ? "Installed"
                            : probe.status === "missing"
                              ? "Missing"
                              : "Not checked"}
                      </span>
                    </div>

                    <label>Source
                      <select
                        value={config.mode}
                        onChange={(e) =>
                          setLanguageServerConfig(language, { mode: e.target.value as LanguageServerMode })
                        }
                      >
                        <option value="path">Use PATH</option>
                        <option value="bundled">Use bundled binary</option>
                        <option value="custom">Use custom path</option>
                      </select>
                    </label>

                    {config.mode === "custom" && (
                      <label>Executable path
                        <input
                          value={config.customPath}
                          placeholder={`C:\\tools\\${binary}${language === "rust" ? ".exe" : ".cmd"}`}
                          onChange={(e) => setLanguageServerConfig(language, { customPath: e.target.value })}
                        />
                      </label>
                    )}

                    <div className="lsp-details">
                      <span>Expected binary</span>
                      <code>{binary}</code>
                      {probe.command && (
                        <>
                          <span>Resolved command</span>
                          <code>{probe.command}</code>
                        </>
                      )}
                      {probe.version && (
                        <>
                          <span>Version</span>
                          <code>{probe.version}</code>
                        </>
                      )}
                      {probe.error && (
                        <>
                          <span>Error</span>
                          <code>{probe.error}</code>
                        </>
                      )}
                    </div>

                    <div className="row">
                      <button onClick={() => probeLanguageServer(language)} disabled={probe.status === "checking"}>
                        {probe.status === "checking" ? "Checking..." : "Check install"}
                      </button>
                      <button className="ghost" onClick={() => installLanguageServer(language)}>
                        Install / update
                      </button>
                      <span className="hint">
                        {config.mode === "path"
                          ? "Rush will resolve the server from PATH."
                          : config.mode === "bundled"
                            ? "Rush will prefer app-bundled language-servers, then fallback to PATH."
                            : "Rush will launch the exact path above."}
                      </span>
                    </div>
                    {lspInstallJobs[language] && (
                      <p className="hint">Install job started: {lspInstallJobs[language]}</p>
                    )}
                  </section>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="settings-body">
            <p className="hint">
              Connect local MCP servers over stdio. Connected servers stay alive until
              you disconnect them, and discovered tools become available to the agent
              through MCP tool calls.
            </p>

            <section className="mcp-presets">
              <div className="mcp-list-head">
                <strong>Quick connections</strong>
                <span>{MCP_PRESETS.length} presets</span>
              </div>
              <div className="mcp-preset-grid">
                {MCP_PRESETS.map((preset) => {
                  const values = presetValues(preset.id);
                  const hasRequiredValues = missingPresetFields(preset, values).length === 0;
                  const isBusy = mcpBusyId === `preset:${preset.id}` || mcpBusyId === `connect:${preset.id}`;
                  return (
                    <article className={`mcp-preset-card ${preset.risk}`} key={preset.id}>
                      <div className="mcp-preset-head">
                        <div>
                          <strong>{preset.label}</strong>
                          <span>{preset.category}</span>
                        </div>
                        <span className={`mcp-risk ${preset.risk}`}>{preset.risk}</span>
                      </div>
                      <p>{preset.description}</p>
                      {preset.fields.length > 0 && (
                        <div className="mcp-preset-fields">
                          {preset.fields.map((field) => (
                            <label key={field.key}>
                              <span>{field.label}</span>
                              <input
                                type={field.kind === "password" ? "password" : "text"}
                                value={values[field.key] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(event) => setPresetValue(preset.id, field.key, event.target.value)}
                              />
                            </label>
                          ))}
                        </div>
                      )}
                      <details>
                        <summary>Requirements</summary>
                        <ul>
                          {preset.requirements.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      </details>
                      <div className="row">
                        <button
                          className="ghost small"
                          onClick={() => void applyMcpPreset(preset, false)}
                          disabled={isBusy || !hasRequiredValues}
                        >
                          {isBusy ? "Working..." : "Add preset"}
                        </button>
                        <button
                          className="ghost small"
                          onClick={() => void applyMcpPreset(preset, true)}
                          disabled={isBusy || !hasRequiredValues}
                        >
                          Add & connect
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>

            <div className="mcp-layout">
              <section className="mcp-editor provider-card">
                <div className="row">
                  <strong>{mcpDraft.id ? "Edit MCP server" : "Add MCP server"}</strong>
                  <span className="tag">{mcpDraft.transport}</span>
                </div>
                <label>Server ID
                  <input
                    value={mcpDraft.id}
                    placeholder="docs"
                    onChange={(e) => setMcpDraft((d) => ({ ...d, id: e.target.value }))}
                  />
                </label>
                <label>Label
                  <input
                    value={mcpDraft.label}
                    placeholder="Docs MCP"
                    onChange={(e) => setMcpDraft((d) => ({ ...d, label: e.target.value }))}
                  />
                </label>
                <label>Transport
                  <select
                    value={mcpDraft.transport}
                    onChange={(e) => setMcpDraft((d) => ({ ...d, transport: e.target.value as McpTransport }))}
                  >
                    <option value="stdio">stdio</option>
                    <option value="http">http / sse (later)</option>
                  </select>
                </label>
                {mcpDraft.transport === "stdio" ? (
                  <>
                    <label>Command
                      <input
                        value={mcpDraft.command}
                        placeholder="node"
                        onChange={(e) => setMcpDraft((d) => ({ ...d, command: e.target.value }))}
                      />
                    </label>
                    <label>Arguments
                      <input
                        value={mcpDraft.args}
                        placeholder="server.js --stdio"
                        onChange={(e) => setMcpDraft((d) => ({ ...d, args: e.target.value }))}
                      />
                    </label>
                    <label>Environment
                      <textarea
                        value={mcpDraft.env}
                        placeholder={"API_KEY=value\nOTHER=value"}
                        onChange={(e) => setMcpDraft((d) => ({ ...d, env: e.target.value }))}
                      />
                    </label>
                  </>
                ) : (
                  <label>URL
                    <input
                      value={mcpDraft.url}
                      placeholder="https://example.com/mcp"
                      onChange={(e) => setMcpDraft((d) => ({ ...d, url: e.target.value }))}
                    />
                  </label>
                )}
                <label className="toggle-row mcp-enabled">
                  <span>
                    <strong>Enabled</strong>
                    <small>{mcpDraft.enabled ? "Available to Rush" : "Stored but inactive"}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={mcpDraft.enabled}
                    onChange={(e) => setMcpDraft((d) => ({ ...d, enabled: e.target.checked }))}
                  />
                </label>
                <div className="row">
                  <button onClick={saveMcpServer} disabled={mcpBusyId === "save"}>
                    {mcpBusyId === "save" ? "Saving..." : "Save server"}
                  </button>
                  <button className="ghost" onClick={() => setMcpDraft(emptyMcpDraft())}>
                    Clear
                  </button>
                </div>
              </section>

              <section className="mcp-list">
                <div className="mcp-list-head">
                  <strong>MCP servers configured</strong>
                  <span>{mcpServers.length} saved</span>
                </div>
                {mcpServers.length === 0 ? (
                  <div className="mcp-empty">
                    <strong>No MCP servers configured.</strong>
                    <span>Add a stdio server to make external tools available.</span>
                  </div>
                ) : (
                  mcpServers.map((server) => {
                    const status = mcpStatuses[server.id] ?? "disconnected";
                    const resources = mcpResources.filter((resource) => resource.serverId === server.id);
                    const tools = mcpTools.filter((tool) => tool.serverId === server.id);
                    const isBusy = mcpBusyId?.endsWith(`:${server.id}`) ?? false;
                    return (
                      <article className={`mcp-server-card ${status}`} key={server.id}>
                        <div className="mcp-server-head">
                          <div>
                            <strong>{server.label}</strong>
                            <span>{server.id}</span>
                          </div>
                          <span className={`mcp-status ${status}`}>{status}</span>
                        </div>
                        <div className="mcp-command">
                          {server.transport === "stdio"
                            ? [server.command, ...(server.args ?? [])].filter(Boolean).join(" ") || "No command"
                            : server.url || "No URL"}
                        </div>
                        {mcpErrors[server.id] && <p className="hint error">{mcpErrors[server.id]}</p>}
                        <div className="row mcp-server-actions">
                          <button className="ghost small" onClick={() => setMcpDraft(mcpDraftFromServer(server))}>
                            Edit
                          </button>
                          {status === "connected" ? (
                            <button
                              className="ghost small"
                              onClick={() => disconnectMcpServer(server.id)}
                              disabled={isBusy}
                            >
                              {mcpBusyId === `disconnect:${server.id}` ? "Disconnecting..." : "Disconnect"}
                            </button>
                          ) : (
                            <button
                              className="ghost small"
                              onClick={() => connectMcpServer(server.id)}
                              disabled={isBusy || server.transport !== "stdio" || !server.enabled}
                            >
                              {mcpBusyId === `connect:${server.id}` ? "Connecting..." : "Connect"}
                            </button>
                          )}
                          <button
                            className="ghost small danger"
                            onClick={() => removeMcpServer(server.id)}
                            disabled={isBusy}
                          >
                            Remove
                          </button>
                        </div>
                        <div className="mcp-discovery">
                          <div>
                            <span>Tools</span>
                            {tools.length ? tools.map((tool) => (
                              <code key={tool.name} title={tool.description}>{tool.name}</code>
                            )) : <em>None discovered</em>}
                          </div>
                          <div>
                            <span>Resources</span>
                            {resources.length ? resources.map((resource) => (
                              <code key={resource.uri} title={resource.description}>{resource.name || resource.uri}</code>
                            )) : <em>None discovered</em>}
                          </div>
                        </div>
                      </article>
                    );
                  })
                )}
              </section>
            </div>

            {mcpMessage && <pre className="mcp-message">{mcpMessage}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
