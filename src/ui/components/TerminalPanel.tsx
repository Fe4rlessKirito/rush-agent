import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "../../core/agent/tauriFs";

// Live terminal panel. The Rust side buffers shell output and exposes it via
// pull commands (terminal_read / terminal_wait_for_output) rather than events,
// so we "stream" by polling terminal_read on a short interval and appending any
// new output. Input is sent with terminal_send_line; start/interrupt/stop map
// to the matching backend commands.

const POLL_MS = 300;

export function TerminalPanel() {
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const viewRef = useRef<HTMLDivElement | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const tauri = isTauriRuntime();

  const append = useCallback((text: string) => {
    setOutput((prev) => {
      const next = prev + text;
      // Cap the client buffer so a long-running command can't grow unbounded.
      return next.length > 200_000 ? next.slice(next.length - 200_000) : next;
    });
  }, []);

  // Poll the backend buffer for new output while the session is running.
  const poll = useCallback(async () => {
    try {
      const chunk = await invoke<string>("terminal_read");
      if (chunk && chunk !== "No new terminal output.") append(chunk);
    } catch {
      /* session may have ended between ticks; stop polling on stop() */
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

  // Auto-scroll to the newest output.
  useEffect(() => {
    const el = viewRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  // Stop polling and kill the session when the panel unmounts.
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
      /* ignore */
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
      /* ignore */
    }
    setRunning(false);
  };

  if (!tauri) {
    return (
      <div className="terminal-panel">
        <div className="terminal-header">
          <span className="terminal-title">Terminal</span>
        </div>
        <div className="terminal-unavailable">
          The terminal is only available in the desktop app.
        </div>
      </div>
    );
  }

  return (
    <div className="terminal-panel">
      <div className="terminal-header">
        <span className="terminal-title">Terminal</span>
        <div className="terminal-controls">
          {!running ? (
            <button className="terminal-btn" onClick={start} disabled={busy}>
              {busy ? "Starting\u2026" : "Start"}
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
        </div>
      </div>
      <div className="terminal-output" ref={viewRef}>
        <pre>{output || (running ? "" : "Terminal not started.")}</pre>
      </div>
      <div className="terminal-input">
        <span className="terminal-prompt">{"›"}</span>
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
    </div>
  );
}
