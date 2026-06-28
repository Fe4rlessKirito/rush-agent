import { useState } from "react";
import { useDraggable } from "../hooks/useDraggable";
import { thinkingForEffort } from "../../core/effort";
import { createProvider } from "../../core/providers/registry";
import { useAppStore } from "../../core/store";
import { useNotificationStore } from "../../core/notificationStore";
import { useResearchStore } from "../../core/researchStore";
import { buildNoSearchResultsReport, formatSearchResults, searchProviderStatus, searchWeb, type SearchEngine } from "../../core/searchProviders";

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
      updateRun(id, {
        sources: searchResponse.results,
        searchWarning: searchResponse.warning,
        content: searchResponse.warning ? `Search warning: ${searchResponse.warning}\n\n` : "",
      });
      if (searchResponse.results.length === 0) {
        updateRun(id, {
          status: "completed",
          content: buildNoSearchResultsReport(prompt.trim(), searchResponse),
        });
        return;
      }
      let content = searchResponse.warning ? `Search warning: ${searchResponse.warning}\n\n` : "";

      const settingsText = [
        `Rounds: ${values.rounds}`,
        `Format: ${values.format}`,
        `Search engine preference: ${values.engine}`,
        `Endpoint: ${values.endpoint}`,
        `Model: ${selectedModel}`,
      ].join("\n");

      for await (const chunk of provider.streamChat({
        model: selectedModel,
        messages: [
          {
            role: "system",
            content:
              "You are Rush Deep Research. Produce a careful, structured Markdown research report from the user's prompt using only the provided search results as source context. Do not fill gaps from memory. If the search results are weak, be explicit about uncertainty and avoid unsupported claims. Include: summary, key findings, source notes, uncertainties, and next steps.",
          },
          {
            role: "user",
            content: `Research prompt:\n${prompt.trim()}\n\nSettings:\n${settingsText}\n\nSearch results:\n${formatSearchResults(searchResponse)}`,
          },
        ],
        maxTokens: 4096,
        thinking: selectedProvider.supportsThinking ? thinkingForEffort(2) : undefined,
      })) {
        if (chunk.delta) {
          content += chunk.delta;
          updateRun(id, { content });
        }
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
