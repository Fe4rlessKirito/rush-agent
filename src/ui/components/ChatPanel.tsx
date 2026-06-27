import { useEffect, useRef, useState } from "react";
import { useAppStore, type ChatLine } from "../../core/store";
import { useProjectStore } from "../../core/projectStore";
import { ProviderRegistry, createProvider } from "../../core/providers/registry";
import { ToolRegistry, type ConfirmRequest } from "../../core/agent/tools";
import { createFsTools } from "../../core/agent/fsTools";
import { createDevFs } from "../../core/agent/devFs";
import { createTauriFs, isTauriRuntime } from "../../core/agent/tauriFs";
import { createCodeTools } from "../../core/agent/codeTools";
import { createGitTools } from "../../core/agent/gitTools";
import { createPackageTools } from "../../core/agent/packageTools";
import { createTerminalTools } from "../../core/agent/terminalTools";
import { runAgent, type AgentEvent } from "../../core/agent/agentLoop";
import type { ChatMessage } from "../../core/providers/types";
import { Markdown } from "./Markdown";
import "highlight.js/styles/github-dark.css";

const fs = isTauriRuntime() ? createTauriFs() : createDevFs();
const tools = new ToolRegistry();
tools.registerAll(createFsTools(fs));
tools.registerAll(createCodeTools());
tools.registerAll(createGitTools());
tools.registerAll(createPackageTools());
tools.registerAll(createTerminalTools());

type ChatMode = "plain" | "agent";

interface Props {
  mode?: ChatMode;
}

export function ChatPanel({ mode = "agent" }: Props) {
  const {
    providers,
    activeProviderId,
    activeModel,
    setActive,
    chat: agentChat,
    setChat: setAgentChat,
    clearChat: clearAgentChat,
    plainChat,
    setPlainChat,
    clearPlainChat,
  } = useAppStore();
  const isAgentMode = mode === "agent";
  const chat = isAgentMode ? agentChat : plainChat;
  const setChat = isAgentMode ? setAgentChat : setPlainChat;
  const clearChat = isAgentMode ? clearAgentChat : clearPlainChat;
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
  // Pending destructive-action confirmation. When set, a modal asks the user to
  // Allow or Deny; the stored resolver feeds their choice back to the tool gate.
  const [confirm, setConfirm] = useState<
    { req: ConfirmRequest; resolve: (ok: boolean) => void } | null
  >(null);

  // Install the confirmation handler once. The registry calls this for every
  // destructive tool; we surface a modal and resolve with the user's choice.
  useEffect(() => {
    tools.setConfirmer(
      (req) =>
        new Promise<boolean>((resolve) => {
          setConfirm({ req, resolve });
        }),
    );
    return () => tools.setConfirmer(null);
  }, []);

  const resolveConfirm = (ok: boolean) => {
    setConfirm((c) => {
      c?.resolve(ok);
      return null;
    });
  };

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

    if (!isAgentMode) {
      const history: ChatMessage[] = chat
        .filter((line) => line.role === "user" || line.role === "agent")
        .map((line) => ({
          role: line.role === "user" ? "user" : "assistant",
          content: line.text,
        }));

      try {
        for await (const chunk of provider.streamChat({
          model: activeModel,
          messages: [
            {
              role: "system",
              content:
                "You are Rush in plain chat mode. Chat naturally with the user. Do not use tools, claim tool access, inspect files, run commands, or make changes.",
            },
            ...history,
            { role: "user", content: userText },
          ],
          signal: abortRef.current.signal,
        })) {
          if (!chunk.delta) continue;
          setChat((l) => {
            const next = l.slice();
            const cur = next[next.length - 1];
            next[next.length - 1] = { ...cur, role: "agent", text: cur.text + chunk.delta };
            return next;
          });
        }
      } catch (err) {
        setChat((l) => {
          const next = l.slice();
          const cur = next[next.length - 1];
          next[next.length - 1] = {
            ...cur,
            role: "agent",
            text: `${cur.text}${cur.text ? "\n\n" : ""}Error: ${String(err)}`,
          };
          return next;
        });
      } finally {
        setBusy(false);
      }
      return;
    }

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
        <span className="chat-title">{isAgentMode ? "Code Agent" : "Chat"}</span>
        <button className="chat-clear" onClick={newChat} disabled={!chat.length && !busy}>
          {isAgentMode ? "New task" : "New chat"}
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
          placeholder={
            isAgentMode
              ? "Ask Rush to inspect, edit, run, or explain code..."
              : "Message Rush..."
          }
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <div className="composer-bar">
          {isAgentMode && (
            <>
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
            </>
          )}

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

      {confirm && (
        <div className="confirm-overlay" role="dialog" aria-modal="true">
          <div className="confirm-modal">
            <div className="confirm-title">Confirm action</div>
            <p className="confirm-summary">{confirm.req.summary}</p>
            <div className="confirm-tool">
              <code>{confirm.req.tool}</code>
            </div>
            <div className="confirm-actions">
              <button className="confirm-deny" onClick={() => resolveConfirm(false)}>
                Deny
              </button>
              <button className="confirm-allow" onClick={() => resolveConfirm(true)}>
                Allow
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
