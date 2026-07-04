import { useEffect, useMemo, useRef, useState } from "react";
import { useDraggable } from "../hooks/useDraggable";

const LOCAL_PROXY_V1 = "http://127.0.0.1:8000/v1";
const FOCUS_AREAS = [
  "security headers and browser hardening",
  "authentication and session handling risks",
  "forms, redirects, and user input exposure",
  "JavaScript exposure, secrets, and client-side configuration leaks",
  "CORS, CSP, mixed content, and cross-origin boundaries",
  "information disclosure, metadata, and dependency/version leaks",
  "TLS, cookies, cache behavior, and transport assumptions",
  "general defensive architecture and obvious production mistakes",
];

interface LocalModel {
  id: string;
}

interface ProbeEvidence {
  url: string;
  finalUrl?: string;
  status?: number;
  ok?: boolean;
  headers: Record<string, string>;
  textSample: string;
  scripts: string[];
  forms: string[];
  links: string[];
  error?: string;
}

interface ProbeFinding {
  id: number;
  model: string;
  focus: string;
  status: "running" | "done" | "error";
  content: string;
  error?: string;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function extractModels(data: unknown): LocalModel[] {
  const list = Array.isArray((data as { data?: unknown[] })?.data) ? (data as { data: unknown[] }).data : Array.isArray(data) ? data : [];
  return list
    .map((item) => {
      if (typeof item === "string") return { id: item };
      const id = (item as { id?: unknown; name?: unknown; model?: unknown })?.id ?? (item as { name?: unknown })?.name ?? (item as { model?: unknown })?.model;
      return typeof id === "string" && id.trim() ? { id: id.trim() } : null;
    })
    .filter((item): item is LocalModel => Boolean(item));
}

function pickModels(models: LocalModel[], filter: string, count: number): string[] {
  const terms = filter.toLowerCase().split(/[\s,/|]+/).map((term) => term.trim()).filter(Boolean);
  const preferred = terms.length > 0
    ? models.filter((model) => terms.some((term) => model.id.toLowerCase().includes(term)))
    : models;
  const pool = preferred.length > 0 ? preferred : models;
  if (pool.length === 0) return [];
  return Array.from({ length: count }, (_, index) => pool[index % pool.length].id);
}

function passiveEvidencePrompt(evidence: ProbeEvidence): string {
  return JSON.stringify({
    url: evidence.url,
    finalUrl: evidence.finalUrl,
    status: evidence.status,
    ok: evidence.ok,
    headers: evidence.headers,
    scripts: evidence.scripts.slice(0, 30),
    forms: evidence.forms.slice(0, 20),
    links: evidence.links.slice(0, 40),
    textSample: evidence.textSample,
    fetchError: evidence.error,
  }, null, 2).slice(0, 18000);
}

function summarizeFindings(findings: ProbeFinding[]): string {
  const done = findings.filter((finding) => finding.status === "done" && finding.content.trim());
  if (done.length === 0) return "No completed findings yet.";
  const buckets = [
    ["Critical", /critical|severe|secret|private key|credential|auth bypass/i],
    ["High", /high|xss|csrf|cors|session|cookie|token|injection/i],
    ["Medium", /medium|csp|header|redirect|mixed content|version|dependency/i],
    ["Low / Info", /low|info|informational|hardening|recommend/i],
  ] as const;
  return buckets.map(([label, pattern]) => {
    const matches = done.filter((finding) => pattern.test(finding.content)).slice(0, 8);
    if (matches.length === 0) return `### ${label}\nNo repeated ${label.toLowerCase()} signals yet.`;
    return [`### ${label}`, ...matches.map((finding) => `- ${finding.model} (${finding.focus}): ${finding.content.split("\n").find(Boolean)?.slice(0, 260) ?? "Finding reported."}`)].join("\n");
  }).join("\n\n");
}

async function collectEvidence(url: string, signal: AbortSignal): Promise<ProbeEvidence> {
  const evidence: ProbeEvidence = {
    url,
    headers: {},
    textSample: "",
    scripts: [],
    forms: [],
    links: [],
  };
  try {
    const response = await fetch(url, { cache: "no-store", signal });
    evidence.finalUrl = response.url;
    evidence.status = response.status;
    evidence.ok = response.ok;
    response.headers.forEach((value, key) => {
      evidence.headers[key] = value;
    });
    const text = await response.text();
    evidence.textSample = text.slice(0, 12000);
    try {
      const doc = new DOMParser().parseFromString(text, "text/html");
      evidence.scripts = Array.from(doc.querySelectorAll("script[src]")).map((node) => (node as HTMLScriptElement).src).filter(Boolean).slice(0, 50);
      evidence.forms = Array.from(doc.querySelectorAll("form")).map((form) => {
        const el = form as HTMLFormElement;
        return `${el.method || "GET"} ${el.action || "(same page)"}`;
      }).slice(0, 30);
      evidence.links = Array.from(doc.querySelectorAll("a[href]")).map((node) => (node as HTMLAnchorElement).href).filter(Boolean).slice(0, 80);
    } catch {
      // Non-HTML or parser failure still leaves headers/text for model review.
    }
  } catch (err) {
    evidence.error = String(err);
  }
  return evidence;
}

async function callLocalProbe(model: string, url: string, focus: string, evidence: ProbeEvidence, signal: AbortSignal): Promise<string> {
  const response = await fetch(`${LOCAL_PROXY_V1}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        {
          role: "system",
          content: [
            "You are a defensive web security reviewer helping the site owner find mistakes before attackers do.",
            "Use only passive evidence supplied by the user. Do not suggest exploit payloads, brute force, DoS, credential attacks, stealth, or destructive testing.",
            "Return concise Markdown with: Findings, Evidence, Risk, Fixes. If evidence is insufficient, say exactly what passive check is missing.",
          ].join("\n"),
        },
        {
          role: "user",
          content: [
            `Authorized target URL: ${url}`,
            `Focus area: ${focus}`,
            "Passive evidence bundle:",
            passiveEvidencePrompt(evidence),
          ].join("\n\n"),
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`local proxy ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return String(data.choices?.[0]?.message?.content ?? data.content ?? data.text ?? "").trim() || "No findings returned.";
}

export function WebProbingView({ onClose }: { onClose: () => void }) {
  const { onMouseDown, style } = useDraggable(".web-probing-shell");
  const [url, setUrl] = useState("");
  const [authorized, setAuthorized] = useState(false);
  const [agentCount, setAgentCount] = useState(100);
  const [concurrency, setConcurrency] = useState(8);
  const [modelFilter, setModelFilter] = useState("mistral qwen");
  const [models, setModels] = useState<LocalModel[]>([]);
  const [modelError, setModelError] = useState("");
  const [evidence, setEvidence] = useState<ProbeEvidence | null>(null);
  const [findings, setFindings] = useState<ProbeFinding[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`${LOCAL_PROXY_V1}/models`, { cache: "no-store" })
      .then((res) => res.ok ? res.json() : Promise.reject(new Error(`models ${res.status}`)))
      .then((data) => {
        if (!cancelled) setModels(extractModels(data));
      })
      .catch((err) => {
        if (!cancelled) setModelError(String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedModels = useMemo(
    () => pickModels(models, modelFilter, clampNumber(agentCount, 1, 100)),
    [agentCount, modelFilter, models],
  );
  const summary = useMemo(() => summarizeFindings(findings), [findings]);
  const completed = findings.filter((finding) => finding.status === "done").length;
  const failed = findings.filter((finding) => finding.status === "error").length;

  async function startProbe() {
    const target = normalizeUrl(url);
    if (!target || !authorized || running) return;
    const count = clampNumber(agentCount, 1, 100);
    const limit = clampNumber(concurrency, 1, 20);
    const chosen = pickModels(models, modelFilter, count);
    if (chosen.length === 0) {
      setModelError("No local proxy models matched. Try clearing the model filter or confirm /v1/models is available.");
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setFindings(chosen.map((model, index) => ({ id: index, model, focus: FOCUS_AREAS[index % FOCUS_AREAS.length], status: "running", content: "" })));

    try {
      const nextEvidence = await collectEvidence(target, controller.signal);
      setEvidence(nextEvidence);
      let cursor = 0;
      async function worker() {
        while (cursor < chosen.length && !controller.signal.aborted) {
          const index = cursor++;
          const model = chosen[index];
          const focus = FOCUS_AREAS[index % FOCUS_AREAS.length];
          try {
            const content = await callLocalProbe(model, target, focus, nextEvidence, controller.signal);
            setFindings((items) => items.map((item) => item.id === index ? { ...item, status: "done", content } : item));
          } catch (err) {
            if (controller.signal.aborted) return;
            setFindings((items) => items.map((item) => item.id === index ? { ...item, status: "error", error: String(err), content: "" } : item));
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(limit, chosen.length) }, () => worker()));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setRunning(false);
    }
  }

  function stopProbe() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }

  return (
    <div className="research-overlay web-probing-overlay" role="dialog" aria-modal="true">
      <div className="research-shell web-probing-shell" style={style}>
        <div className="research-window-title" onMouseDown={onMouseDown}>
          <div className="research-brand web-probing-brand">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="8" />
              <path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" />
              <path d="m15.5 15.5 3 3" />
            </svg>
            <span>Web Probing</span>
          </div>
          <div className="research-window-actions">
            <button onClick={onClose} aria-label="Close Web Probing">x</button>
          </div>
        </div>

        <div className="web-probing-grid">
          <section className="research-card web-probing-card">
            <div className="research-card-head">
              <h2>Passive defensive website audit <small>local proxy only</small></h2>
            </div>
            <p>
              This runs passive analysis for a site you own or are authorized to test. It does not run exploit payloads, login attempts, brute force, or load tests.
            </p>
            <label className="web-probing-field">
              <span>Website URL</span>
              <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" />
            </label>
            <label className="web-probing-auth">
              <input type="checkbox" checked={authorized} onChange={(e) => setAuthorized(e.target.checked)} />
              <span>I own this site or have authorization to test it.</span>
            </label>
            <div className="web-probing-controls">
              <label><span>Agents</span><input type="number" min="1" max="100" value={agentCount} onChange={(e) => setAgentCount(clampNumber(Number(e.target.value), 1, 100))} /></label>
              <label><span>Concurrency</span><input type="number" min="1" max="20" value={concurrency} onChange={(e) => setConcurrency(clampNumber(Number(e.target.value), 1, 20))} /></label>
              <label><span>Model filter</span><input value={modelFilter} onChange={(e) => setModelFilter(e.target.value)} placeholder="mistral qwen" /></label>
            </div>
            <div className="web-probing-actions">
              <button className="research-start" onClick={startProbe} disabled={running || !authorized || !url.trim()}>Start probe</button>
              <button className="ghost" onClick={stopProbe} disabled={!running}>Stop</button>
            </div>
            <p className="hint">
              Models matched: {selectedModels.length > 0 ? `${new Set(selectedModels).size} unique / ${selectedModels.length} agents` : "none"}
              {modelError ? ` · ${modelError}` : ""}
            </p>
          </section>

          <section className="research-card web-probing-card">
            <div className="research-card-head">
              <h2>Progress <small>passive evidence only</small></h2>
            </div>
            <div className="web-probing-stats">
              <span><strong>{completed}</strong> done</span>
              <span><strong>{failed}</strong> failed</span>
              <span><strong>{findings.length}</strong> total</span>
            </div>
            {evidence && (
              <div className="web-probing-evidence">
                <strong>Evidence</strong>
                <span>{evidence.status ? `HTTP ${evidence.status}` : "Browser fetch unavailable"}</span>
                <span>{evidence.finalUrl ?? evidence.url}</span>
                {evidence.error && <span>{evidence.error}</span>}
              </div>
            )}
            <pre className="web-probing-summary">{summary}</pre>
          </section>
        </div>

        <section className="research-card web-probing-results">
          <div className="research-card-head">
            <h2>Model notes <small>{completed + failed}/{findings.length}</small></h2>
          </div>
          <div className="web-probing-notes">
            {findings.length === 0 ? (
              <div className="web-probing-empty">Start a probe to collect model reviews.</div>
            ) : findings.map((finding) => (
              <article className={`web-probing-note ${finding.status}`} key={finding.id}>
                <div>
                  <strong>{finding.model}</strong>
                  <span>{finding.focus}</span>
                  <em>{finding.status}</em>
                </div>
                <p>{finding.error || finding.content || "Running..."}</p>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
