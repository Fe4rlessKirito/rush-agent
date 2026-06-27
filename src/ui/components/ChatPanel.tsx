import { useEffect, useRef, useState } from "react";
import { useAppStore, type ChatLine } from "../../core/store";
import { useProjectStore } from "../../core/projectStore";
import { ProviderRegistry, createProvider } from "../../core/providers/registry";
import { ToolRegistry } from "../../core/agent/tools";
import { createFsTools } from "../../core/agent/fsTools";
import { createDevFs } from "../../core/agent/devFs";
import { createGitTools } from "../../core/agent/gitTools";
import { runAgent, type AgentEvent } from "../../core/agent/agentLoop";
import { Markdown } from "./Markdown";
import "highlight.js/styles/github-dark.css";

const fs = createDevFs();
const tools = new ToolRegistry();
tools.registerAll(createFsTools(fs));
tools.registerAll(createGitTools());

export function ChatPanel() {
  const { providers, activeProviderId, activeModel, setActive, chat, setChat, clearChat } =
    useAppStore();
  // Custom instructions for the currently-open project, fed into the agent's
  // system prompt so each project can steer the model differently.
  const projectInstructions = useProjectStore(
    (s) => s.projects.find((p) => p.id === s.activeProjectId)?.instructions ?? "",
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  // Models offered by the active provider, for the composer's model selector.
  // Falls back to just the active model if the list can't be fetched.
  const [models, setModels] = useState<string[]>([]);
  // Per-line manual override for the thinking disclosure. When a user clicks to
  // open or close a block we honor that choice; otherwise the block follows the
  // auto rule (open while reasoning streams, closed once the answer begins).
  const [openOverride, setOpenOverride] = useState<Record<number, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Load the active provider's model catalog so the selector lists real models.
  // Best-effort: a proxy that blocks CORS or fails just leaves the active model
  // as the only option, which still works.
  useEffect(() => {
    let cancelled = false;
    const cfg = providers.find((p) => p.id === activeProviderId);
    if (!cfg) {
      setModels([]);
      return;
    }
    createProvider(cfg)
      .listModels()
      .then((m) => !cancelled && setModels(m))
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [activeProviderId, providers]);

  // Always include the active model in the options even if the fetch failed or
  // hasn't returned, so the selector never shows an empty/blank value.
  const modelOptions = Array.from(
    new Set([...(activeModel ? [activeModel] : []), ...models]),
  );

  async function send() {
    if (!input.trim() || busy) return;
    if (!activeProviderId || !activeModel) {
      setChat((l) => [...l, { role: "tool", text: "Pick a provider + model in Settings first." }]);
      return;
    }
    const registry = new ProviderRegistry(providers);
    const provider = registry.get(activeProviderId);
    const userText = input;
    setInput("");
    setChat((l) => [...l, { role: "user", text: userText }, { role: "agent", text: "" }]);
    setBusy(true);
    abortRef.current = new AbortController();

    const handle = (e: AgentEvent) => {
      if (e.type === "text" && e.text) {
        setChat((l) => {
          const next = l.slice();
          const cur = next[next.length - 1];
          next[next.length - 1] = { ...cur, role: "agent", text: cur.text + e.text };
          return next;
        });
      } else if (e.type === "thinking" && e.text) {
        setChat((l) => {
          const next = l.slice();
          const cur = next[next.length - 1];
          next[next.length - 1] = {
            ...cur,
            role: "agent",
            thinking: (cur.thinking ?? "") + e.text,
          };
          return next;
        });
      } else if (e.type === "tool_call") {
        setChat((l) => [...l, { role: "tool", text: `\u2192 ${e.toolName}(${JSON.stringify(e.toolArgs)})` }, { role: "agent", text: "" }]);
      } else if (e.type === "tool_result") {
        setChat((l) => [...l, { role: "tool", text: `\u2190 ${e.toolResult?.slice(0, 400)}` }, { role: "agent", text: "" }]);
      } else if (e.type === "error") {
        setChat((l) => [...l, { role: "tool", text: `Error: ${e.text}` }]);
      }
    };

    try {
      for await (const ev of runAgent(
        provider,
        activeModel,
        tools,
        [{ role: "user", content: userText }],
        abortRef.current.signal,
        undefined,
        projectInstructions,
      )) {
        handle(ev);
      }
    } finally {
      setBusy(false);
    }
  }

  function newChat() {
    if (busy) abortRef.current?.abort();
    clearChat();
    setOpenOverride({});
  }

  // The "+" attach button. Real file ingestion is a backend feature; for now it
  // opens a picker and drops the chosen filename into the prompt as context.
  function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setInput((v) => (v ? `${v}\n` : "") + `[attached: ${f.name}]`);
    e.target.value = "";
  }

  // Auto rule: the thinking block stays open while its reasoning is streaming
  // (thinking present, answer not yet started) and snaps shut once the answer
  // text begins. A manual click on the disclosure overrides this for that line.
  function isOpen(line: ChatLine, i: number): boolean {
    if (i in openOverride) return openOverride[i];
    return !line.text.trim();
  }

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <span className="chat-title">Chat</span>
        <button className="chat-clear" onClick={newChat} disabled={!chat.length && !busy}>
          New chat
        </button>
      </div>
      <div className="messages">
        {chat.map((l, i) => (
          <div key={i} className={`msg ${l.role}`}>
            {l.thinking && l.thinking.trim() && (
              <details
                className="thinking-block"
                open={isOpen(l, i)}
                onToggle={(e) =>
                  setOpenOverride((o) => ({ ...o, [i]: (e.target as HTMLDetailsElement).open }))
                }
              >
                <summary>Thinking</summary>
                <Markdown>{l.thinking}</Markdown>
              </details>
            )}
            {l.role === "tool" ? l.text : <Markdown>{l.text}</Markdown>}
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea
          value={input}
          placeholder="Ask Rush to build or change something..."
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          <button
            className="icon-btn attach-btn"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach file"
            title="Attach file"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
            </svg>
          </button>
          <input ref={fileRef} type="file" hidden onChange={onPickFile} />

          <select
            className="model-select"
            value={activeModel ?? ""}
            disabled={!activeProviderId}
            onChange={(e) => activeProviderId && setActive(activeProviderId, e.target.value)}
          >
            {modelOptions.length === 0 ? (
              <option value="">No model</option>
            ) : (
              modelOptions.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))
            )}
          </select>

          <button className="send-btn" onClick={send} disabled={busy} aria-label="Send">
            {busy ? (
              <span className="send-spinner" />
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                <path d="M12 19V5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none" />
                <path d="M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
