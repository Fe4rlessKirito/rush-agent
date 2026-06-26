import { useState } from "react";
import { useAppStore } from "../../core/store";
import type { ProviderConfig } from "../../core/providers/types";
import { createProvider } from "../../core/providers/registry";
import { useDraggable } from "../hooks/useDraggable";

type Tab = "providers" | "proxies";

// Per-proxy model-list state. Models are fetched lazily the first time a proxy
// is expanded, then cached here so reopening it doesn't re-hit the network.
interface ModelState {
  status: "idle" | "loading" | "ready" | "error";
  models: string[];
  error?: string;
  selected?: string;
}

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const { providers, upsertProvider, setActive, activeProviderId, activeModel } = useAppStore();
  const [tab, setTab] = useState<Tab>("providers");
  const [draft, setDraft] = useState<Record<string, ProviderConfig>>(
    Object.fromEntries(providers.map((p) => [p.id, p])),
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [modelState, setModelState] = useState<Record<string, ModelState>>({});
  const { onMouseDown, style } = useDraggable();

  function edit(id: string, patch: Partial<ProviderConfig>) {
    setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } }));
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
      const models = await createProvider(p).listModels();
      setModelState((s) => ({
        ...s,
        [p.id]: { status: "ready", models, selected: models[0] ?? p.defaultModel },
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
        </div>

        {tab === "providers" ? (
          <div className="settings-body">
            <p className="hint">
              Standard vendors and custom proxies share the same form. A proxy is just a
              custom base URL + optional key + headers.
            </p>
            <div className="provider-grid">
              {providers.map((p) => {
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
                    <div className="row">
                      <button onClick={() => upsertProvider({ ...d, enabled: true })}>Save</button>
                      <button className="ghost" onClick={() => setActive(p.id, d.defaultModel)}>
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
        ) : (
          <div className="settings-body">
            <p className="hint">
              Saved proxies. Click one to load the models it offers, then pick a model
              to make it active.
            </p>
            <div className="proxy-list">
              {providers.map((p) => {
                const ms = modelState[p.id];
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
                          ms.models.length === 0 ? (
                            <p className="hint">This proxy returned no models.</p>
                          ) : (
                            <div className="row">
                              <select
                                value={ms.selected}
                                onChange={(e) =>
                                  setModelState((s) => ({
                                    ...s,
                                    [p.id]: { ...s[p.id], selected: e.target.value },
                                  }))
                                }
                              >
                                {ms.models.map((m) => (
                                  <option key={m} value={m}>{m}</option>
                                ))}
                              </select>
                              <button
                                onClick={() => ms.selected && setActive(p.id, ms.selected)}
                                disabled={!ms.selected}
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
        )}
      </div>
    </div>
  );
}
