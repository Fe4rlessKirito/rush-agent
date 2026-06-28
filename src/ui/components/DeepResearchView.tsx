import { useState } from "react";
import { useDraggable } from "../hooks/useDraggable";
import { thinkingForEffort } from "../../core/effort";
import { createProvider } from "../../core/providers/registry";
import { useAppStore } from "../../core/store";
import { useNotificationStore } from "../../core/notificationStore";
import { useResearchStore } from "../../core/researchStore";
import { buildNoSearchResultsReport, formatSearchResults, searchProviderStatus, searchWeb, type SearchEngine } from "../../core/searchProviders";
import { runAgent } from "../../core/agent/agentLoop";
import { ToolRegistry } from "../../core/agent/tools";
import { createWebTools } from "../../core/agent/webTools";

type SelectId = "rounds" | "format" | "engine" | "endpoint" | "model";

const options: Record<SelectId, string[]> = {
  rounds: ["Auto", "1 round", "2 rounds", "3 rounds", "5 rounds"],
  format: ["Auto", "Product", "Compare", "How-to", "Fact-check"],
  engine: ["Default", "searxng", "duckduckgo", "tavily", "brave", "google", "serper"],
  endpoint: ["Default", "Leech Proxy", "OpenAI", "Anthropic", "Localhost"],
  model: ["Default", "Claude Opus", "Claude Sonnet", "GPT 5", "DeepSeek"],
};

function Icon({ name }: { name: "research" | "settings" | "play" | "queue" | "minus" | "close" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === "research" && <><circle {...common} cx="10.5" cy="10.5" r="5.5" /><path {...common} d="m15 15 4 4" /><path {...common} d="M10.5 8v5M8 10.5h5" /></>}
      {name === "settings" && <><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M19 12a7 7 0 0 0-.08-1l2-1.5-2-3.46-2.35.95a7.3 7.3 0 0 0-1.74-1L14.5 3h-5l-.34 2.98a7.3 7.3 0 0 0-1.74 1l-2.35-.95-2 3.46 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .08 1l-2 1.5 2 3.46 2.35-.95a7.3 7.3 0 0 0 1.74 1L9.5 21h5l.34-2.98a7.3 7.3 0 0 0 1.74-1l2.35.95 2-3.46-2-1.5A7 7 0 0 0 19 12Z" /></>}
      {name === "play" && <path {...common} d="m8 5 11 7-11 7V5Z" />}
      {name === "queue" && <><path {...common} d="M12 5v14M5 12h14" /></>}
      {name === "minus" && <path {...common} d="M7 12h10" />}
      {name === "close" && <><path {...common} d="M7 7l10 10" /><path {...common} d="M17 7 7 17" /></>}
    </svg>
  );
}

function ResearchSelect({
  id,
  label,
  value,
  onChange,
}: {
  id: SelectId;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="research-field">
      <span>{label}</span>
      <button
        className={"research-select" + (open ? " open" : "")}
        onClick={() => setOpen((v) => !v)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{value}</span>
        <span className="research-caret">⌄</span>
      </button>
      {open && (
        <div className="research-menu" role="listbox">
          {options[id].map((option) => (
            <button
              key={option}
              className={value === option ? "selected" : ""}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(option);
                setOpen(false);
              }}
              role="option"
              aria-selected={value === option}
            >
              {option}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function maxResearchSteps(rounds: string): number {
  const explicit = Number(rounds.match(/\d+/)?.[0] ?? 0);
  if (explicit > 0) return Math.max(4, Math.min(14, explicit * 3 + 2));
  return 8;
}

function mergeSources<T extends { url: string; title: string; snippet: string; source: string }>(
  current: T[],
  incoming: T[],
): T[] {
  const seen = new Set(current.map((source) => source.url || `${source.title}:${source.snippet}`));
  const next = current.slice();
  for (const source of incoming) {
    const key = source.url || `${source.title}:${source.snippet}`;
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(source);
  }
  return next.slice(0, 30);
}

export function DeepResearchView({ onClose, onOpenLibrary }: { onClose: () => void; onOpenLibrary: () => void }) {
  const providers = useAppStore((s) => s.providers);
  const activeProviderId = useAppStore((s) => s.activeProviderId);
  const activeModel = useAppStore((s) => s.activeModel);
  const createRun = useResearchStore((s) => s.createRun);
  const updateRun = useResearchStore((s) => s.updateRun);
  const notify = useNotificationStore((s) => s.notify);
  const searchConfig = useResearchStore((s) => s.searchConfig);
  const setSearchConfig = useResearchStore((s) => s.setSearchConfig);
  const { onMouseDown, style } = useDraggable(".research-shell");
  const [prompt, setPrompt] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const queued = useResearchStore((s) => s.runs.filter((run) => run.status === "queued").length);
  const [running, setRunning] = useState(false);
  const [values, setValues] = useState<Record<SelectId, string>>({
    rounds: "Auto",
    format: "Auto",
    engine: "Default",
    endpoint: "Default",
    model: "Default",
  });

  const setValue = (id: SelectId, value: string) => setValues((current) => ({ ...current, [id]: value }));

  const selectedProvider = providers.find((p) => {
    if (values.endpoint === "Default") return p.id === activeProviderId;
    if (values.endpoint === "Leech Proxy") return p.id === "leech-proxy";
    if (values.endpoint === "OpenAI") return p.id === "openai-default";
    if (values.endpoint === "Anthropic") return p.id === "anthropic-default";
    if (values.endpoint === "Localhost") return p.id === "localhost-default";
    return p.id === activeProviderId;
  }) ?? providers.find((p) => p.id === activeProviderId);
  const selectedModel = values.model === "Default" ? (activeModel ?? selectedProvider?.defaultModel ?? "default") : values.model;
  const searchStatus = searchProviderStatus(values.engine as SearchEngine, searchConfig);

  function createQueuedRun() {
    if (!prompt.trim()) return;
    createRun({ prompt: prompt.trim(), settings: values, status: "queued" });
  }

  async function startRun() {
    if (!prompt.trim() || running) return;
    if (!selectedProvider) {
      const id = createRun({ prompt: prompt.trim(), settings: values, status: "error" });
      updateRun(id, { error: "Pick a provider and model in Settings first." });
      return;
    }

    const id = createRun({ prompt: prompt.trim(), settings: values, status: "running" });
    notify({
      title: "Deep Research started",
      message: "The run is saved to Library and will update as results stream in.",
      tone: "info",
    });
    setRunning(true);
    try {
      const provider = createProvider(selectedProvider);
      const searchResponse = await searchWeb(prompt.trim(), values.engine as SearchEngine, searchConfig);
      let gatheredSources = searchResponse.results;
      updateRun(id, {
        sources: gatheredSources,
        searchWarning: searchResponse.warning,
        content: searchResponse.warning ? `Search warning: ${searchResponse.warning}\n\n` : "",
      });
      let content = searchResponse.warning ? `Search warning: ${searchResponse.warning}\n\n` : "";

      const settingsText = [
        `Rounds: ${values.rounds}`,
        `Format: ${values.format}`,
        `Search engine preference: ${values.engine}`,
        `Endpoint: ${values.endpoint}`,
        `Model: ${selectedModel}`,
      ].join("\n");

      const researchTools = new ToolRegistry();
      researchTools.registerAll(createWebTools({
        engine: values.engine as SearchEngine,
        getSearchConfig: () => useResearchStore.getState().searchConfig,
        search: async (query, engine, config) => {
          const response = await searchWeb(query, engine, config);
          gatheredSources = mergeSources(gatheredSources, response.results);
          updateRun(id, {
            sources: gatheredSources,
            searchWarning: response.warning ?? searchResponse.warning,
          });
          return response;
        },
      }));

      for await (const event of runAgent(
        provider,
        selectedModel,
        researchTools,
        [
          {
            role: "user",
            content: [
              `Research prompt:\n${prompt.trim()}`,
              "",
              `Settings:\n${settingsText}`,
              "",
              "Initial search results:",
              formatSearchResults(searchResponse),
            ].join("\n"),
          },
        ],
        undefined,
        maxResearchSteps(values.rounds),
        [
          "You are Rush Deep Research.",
          "Build a careful, structured Markdown research report.",
          "Use WebSearch to run follow-up searches when the initial results are missing, weak, too broad, or too narrow.",
          "Use WebFetch on relevant URLs when snippets are not enough.",
          "Use only gathered search/fetch source context for factual claims. Do not fill gaps from memory.",
          "If no usable sources can be found after trying alternate queries, say that clearly and do not produce a guessed report.",
          "Include: summary, key findings, source notes with URLs, uncertainties, and next steps.",
        ].join("\n"),
        selectedProvider.supportsThinking ? thinkingForEffort(2) : undefined,
      )) {
        if (event.type === "text" && event.text) {
          content += event.text;
          updateRun(id, { content });
        } else if (event.type === "tool_call") {
          updateRun(id, {
            content: content || `Searching with ${event.toolName ?? "web tool"}...\n\n`,
          });
        } else if (event.type === "error") {
          updateRun(id, { content, error: event.text ?? "Deep Research tool run failed." });
        }
      }
      if (gatheredSources.length === 0) {
        content = buildNoSearchResultsReport(prompt.trim(), {
          ...searchResponse,
          results: [],
          warning: searchResponse.warning ?? "No search results returned after follow-up searches.",
        });
      }
      updateRun(id, { status: "completed", content });
    } catch (err) {
      updateRun(id, { status: "error", error: String(err) });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="research-overlay" onMouseDown={onClose}>
      <section className="research-shell" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="research-window-title" onMouseDown={onMouseDown}>
          <div className="research-brand"><Icon name="research" /><span>Deep Research</span></div>
          <div className="research-window-actions">
            <button onClick={onClose} title="Minimize Research" aria-label="Minimize Research"><Icon name="minus" /></button>
            <button onClick={onClose} title="Close Research" aria-label="Close Research"><Icon name="close" /></button>
          </div>
        </div>

        <div className="research-card">
          <div className="research-card-head">
            <h2><Icon name="research" /> Research <small>{queued} queued</small></h2>
          </div>
          <p>Multi-step web research with an agent in the loop <span>past runs in <button onClick={onOpenLibrary}>Library</button></span></p>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. How does end-to-end encryption work in Signal, step by step"
          />

          <div className="research-settings">
            <button className="research-settings-head" onClick={() => setCollapsed((v) => !v)}>
              <span><Icon name="settings" /> Settings</span>
              <span className={collapsed ? "" : "open"}>⌄</span>
            </button>
            {!collapsed && (
              <>
                <div className="research-grid">
                  <ResearchSelect id="rounds" label="Rounds" value={values.rounds} onChange={(v) => setValue("rounds", v)} />
                  <ResearchSelect id="format" label="Format" value={values.format} onChange={(v) => setValue("format", v)} />
                  <ResearchSelect id="engine" label="Search Engine" value={values.engine} onChange={(v) => setValue("engine", v)} />
                  <ResearchSelect id="endpoint" label="Endpoint" value={values.endpoint} onChange={(v) => setValue("endpoint", v)} />
                  <ResearchSelect id="model" label="Model" value={values.model} onChange={(v) => setValue("model", v)} />
                </div>
                <div className={`research-provider-status ${searchStatus.ready ? "ready" : "warning"}`}>
                  <strong>{searchStatus.label}</strong>
                  <span>{searchStatus.warning ?? searchStatus.hint}</span>
                </div>
                {(values.engine === "searxng" || values.engine === "tavily" || values.engine === "brave") && (
                  <div className="research-search-config">
                    {values.engine === "searxng" && (
                      <label>
                        <span>SearXNG endpoint</span>
                        <input
                          value={searchConfig.searxngUrl}
                          onChange={(e) => setSearchConfig({ searxngUrl: e.target.value })}
                          placeholder="https://your-searxng.example"
                        />
                      </label>
                    )}
                    {values.engine === "tavily" && (
                      <label>
                        <span>Tavily API key</span>
                        <input
                          type="password"
                          value={searchConfig.tavilyKey}
                          onChange={(e) => setSearchConfig({ tavilyKey: e.target.value })}
                          placeholder="tvly-..."
                        />
                      </label>
                    )}
                    {values.engine === "brave" && (
                      <label>
                        <span>Brave API key</span>
                        <input
                          type="password"
                          value={searchConfig.braveKey}
                          onChange={(e) => setSearchConfig({ braveKey: e.target.value })}
                          placeholder="Brave Search API key"
                        />
                      </label>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          <div className="research-actions">
            <button className="research-queue" onClick={createQueuedRun} disabled={!prompt.trim()}><Icon name="queue" /> Queue</button>
            <button className="research-start" disabled={!prompt.trim() || running} onClick={startRun}><Icon name="play" /> {running ? "Running..." : "Start"}</button>
          </div>
        </div>
      </section>
    </div>
  );
}
