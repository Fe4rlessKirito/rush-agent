import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../../core/agent/tauriFs";

// Live terminal panel. The Rust side buffers shell output and exposes it via
// pull commands, so we stream by polling terminal_read while a session runs.

const POLL_MS = 300;
const MAX_TERMINAL_OUTPUT_CHARS = 80_000;

export function TerminalPanel() {
  const [running, setRunning] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tauri = isTauriRuntime();

  const append = useCallback((text: string) => {
    setOutput((prev) => {
      const next = prev + text;
      return next.length > MAX_TERMINAL_OUTPUT_CHARS ? next.slice(next.length - MAX_TERMINAL_OUTPUT_CHARS) : next;
    });
  }, []);

  const poll = useCallback(async () => {
    try {
      const chunk = await invoke<string>("terminal_read");
      if (chunk && chunk !== "No new terminal output.") append(chunk);
    } catch {
      // Session may have ended between ticks.
    }
  }, [append]);

  useEffect(() => {
    if (!running) return;
    pollRef.current = setInterval(poll, POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [running, poll]);

  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, collapsed]);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (isTauriRuntime()) void invoke("terminal_stop").catch(() => {});
    };
  }, []);

  const start = async () => {
    if (busy || running) return;
    setBusy(true);
    try {
      const msg = await invoke<string>("terminal_start", {});
      append(`${msg}\n`);
      setRunning(true);
    } catch (err) {
      append(`Failed to start terminal: ${String(err)}\n`);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (!running) return;
    const line = input;
    setInput("");
    append(`${line}\n`);
    try {
      await invoke<string>("terminal_send_line", { line });
    } catch (err) {
      append(`send failed: ${String(err)}\n`);
    }
  };

  const interrupt = async () => {
    if (!running) return;
    try {
      await invoke<string>("terminal_interrupt");
      append("^C\n");
    } catch {
      // Ignore interrupt failures.
    }
  };

  const stop = async () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    try {
      const msg = await invoke<string>("terminal_stop");
      append(`${msg}\n`);
    } catch {
      // Ignore stop failures.
    }
    setRunning(false);
  };

  return (
    <div className={"terminal-panel" + (collapsed ? " collapsed" : "")}>
      <div className="terminal-header">
        <button
          className="terminal-collapse"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={collapsed ? "Expand terminal" : "Collapse terminal"}
          title={collapsed ? "Expand terminal" : "Collapse terminal"}
        >
          <span className="terminal-caret" aria-hidden="true">▾</span>
          <span className="terminal-title">Terminal</span>
        </button>

        {tauri && (
          <div className="terminal-controls">
            {!running ? (
              <button className="terminal-btn" onClick={start} disabled={busy}>
                {busy ? "Starting..." : "Start"}
              </button>
            ) : (
              <>
                <button className="terminal-btn" onClick={interrupt} title="Send Ctrl+C">
                  Interrupt
                </button>
                <button className="terminal-btn danger" onClick={stop}>
                  Stop
                </button>
              </>
            )}
            {output && (
              <button className="terminal-btn" onClick={() => setOutput("")} title="Clear terminal output">
                Clear
              </button>
            )}
          </div>
        )}
      </div>

      {!collapsed &&
        (tauri ? (
          <>
            <div className="terminal-output" ref={viewRef}>
              <pre>{output || (running ? "" : "Terminal not started.")}</pre>
            </div>
            <div className="terminal-input">
              <span className="terminal-prompt">{">"}</span>
              <input
                type="text"
                value={input}
                disabled={!running}
                placeholder={running ? "Type a command and press Enter" : "Start the terminal first"}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
            </div>
          </>
        ) : (
          <div className="terminal-unavailable">
            The terminal is only available in the desktop app.
          </div>
        ))}
    </div>
  );
}
