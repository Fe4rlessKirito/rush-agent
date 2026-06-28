import { useMemo } from "react";
import { useFileStore } from "../../core/fileStore";

// Live preview of the project's web files, rendered from the shared fileStore so
// it always reflects current editor content. We assemble a self-contained
// document: the entry HTML with its linked CSS and JS inlined, then hand it to a
// sandboxed iframe via srcdoc. Sandboxing keeps previewed code from touching the
// host app while still letting its own scripts run.

// Find the HTML file to render: prefer index.html, else the first .html file.
function pickEntry(files: Record<string, string>): string | null {
  const htmls = Object.keys(files).filter((p) => p.endsWith(".html"));
  if (htmls.length === 0) return null;
  return htmls.find((p) => p.endsWith("index.html")) ?? htmls.sort()[0];
}

// Resolve a possibly-relative href/src against the entry file's folder so
// "style.css" or "./js/app.js" map back to a key in the flat file map.
function resolve(entry: string, ref: string): string {
  const clean = ref.split(/[?#]/, 1)[0].replace(/\\/g, "/");
  if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith("//")) return clean;
  const parts = (clean.startsWith("/")
    ? clean.slice(1)
    : `${entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/") + 1) : ""}${clean}`
  ).split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

function inlineStyle(css: string): string {
  return css.replace(/<\/style/gi, "<\\/style");
}

function inlineScript(js: string): string {
  return js.replace(/<\/script/gi, "<\\/script");
}

function buildDoc(files: Record<string, string>, entry: string): string {
  let html = files[entry] ?? "";

  // Inline <link rel="stylesheet" href="..."> for files we have in the store.
  html = html.replace(
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
    (tag, href) => {
      const css = files[resolve(entry, href)];
      return css !== undefined ? `<style>${inlineStyle(css)}</style>` : tag;
    },
  );

  // Inline <script src="..."></script> for files we have in the store.
  html = html.replace(
    /<script\b[^>]*src=["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (tag, src) => {
      const js = files[resolve(entry, src)];
      return js !== undefined ? `<script>${inlineScript(js)}<\/script>` : tag;
    },
  );

  return html;
}

export function PreviewPane() {
  const files = useFileStore((s) => s.files);
  const entry = useMemo(() => pickEntry(files), [files]);
  const doc = useMemo(() => (entry ? buildDoc(files, entry) : ""), [files, entry]);

  if (!entry) {
    return (
      <div className="editor-empty">
        <div className="editor-empty-icon">▶</div>
        <p>No HTML file to preview yet. Add an index.html to see it render here.</p>
      </div>
    );
  }

  return (
    <iframe
      className="preview-frame"
      title="Live preview"
      // allow-scripts lets the previewed page's own JS run; we intentionally omit
      // allow-same-origin so it can't reach this app's storage or DOM.
      sandbox="allow-scripts allow-forms allow-modals"
      srcDoc={doc}
    />
  );
}
