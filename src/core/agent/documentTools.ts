import type { FsBackend } from "./fsTools";
import type { Tool } from "./tools";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const num = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.max(min, Math.min(max, num));
}

function truncate(content: string, maxChars: unknown, fallback = 20000): string {
  const max = numberArg(maxChars, fallback, 1000, 100000);
  return content.length > max ? `${content.slice(0, max)}\n\n[truncated to ${max} chars]` : content;
}

function parseCsvLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    const next = line[i + 1];
    if (ch === '"') {
      if (quoted && next === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (ch === delimiter && !quoted) {
      cells.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  cells.push(current);
  return cells;
}

function csvToText(content: string, delimiter: string, maxRows: number): string {
  const rows = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).slice(0, maxRows);
  return rows.map((line) => parseCsvLine(line, delimiter).map((cell) => cell.trim()).join(" | ")).join("\n");
}

async function unsupportedBinaryReader(name: string, path: string): Promise<string> {
  return `${name} cannot extract ${path} in this build yet. Use read_csv for CSV text, or convert the document to text/PDF text and add it with rag_add. Native Office/PDF/OCR extraction will need a Tauri-side parser or optional document parsing dependencies.`;
}

export function createDocumentTools(fs: FsBackend): Tool[] {
  return [
    {
      definition: {
        name: "read_csv",
        description: "Read a CSV file from the workspace and render rows as pipe-separated text.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "CSV file path." },
            delimiter: { type: "string", description: "Single-character delimiter, default comma." },
            max_rows: { type: "number", description: "Maximum rows to return." },
            max_chars: { type: "number", description: "Maximum returned characters." },
          },
          required: ["path"],
        },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing CSV path." };
        const delimiter = (text(args.delimiter) || ",").slice(0, 1);
        const content = await fs.readFile(path);
        const rendered = csvToText(content, delimiter, numberArg(args.max_rows, 1000, 1, 10000));
        return { ok: true, content: truncate(rendered || "(empty csv)", args.max_chars) };
      },
    },
    {
      definition: {
        name: "read_docx",
        description: "Best-effort DOCX text reader. In the current build this reports when native DOCX extraction is unavailable.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "number" } }, required: ["path"] },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing DOCX path." };
        return { ok: true, content: truncate(await unsupportedBinaryReader("read_docx", path), args.max_chars) };
      },
    },
    {
      definition: {
        name: "read_pptx",
        description: "Best-effort PPTX text reader. In the current build this reports when native PPTX extraction is unavailable.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "number" } }, required: ["path"] },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing PPTX path." };
        return { ok: true, content: truncate(await unsupportedBinaryReader("read_pptx", path), args.max_chars) };
      },
    },
    {
      definition: {
        name: "read_excel",
        description: "Best-effort Excel reader. CSV is fully supported; XLSX extraction requires a future parser/backend.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, sheet: { type: "string" }, max_rows: { type: "number" }, max_chars: { type: "number" } }, required: ["path"] },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing Excel path." };
        if (/\.csv$/i.test(path)) {
          const content = await fs.readFile(path);
          return { ok: true, content: truncate(csvToText(content, ",", numberArg(args.max_rows, 1000, 1, 10000)), args.max_chars) };
        }
        return { ok: true, content: truncate(await unsupportedBinaryReader("read_excel", path), args.max_chars) };
      },
    },
    {
      definition: {
        name: "write_excel",
        description: "Write tabular data as a CSV-compatible spreadsheet file. Use .csv for fully portable output in this build.",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "Output path, preferably .csv." },
            rows: { type: "array", description: "Rows as arrays or scalar values." },
          },
          required: ["path", "rows"],
        },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing output path." };
        if (!Array.isArray(args.rows)) return { ok: false, isError: true, content: "rows must be an array." };
        const csv = args.rows.map((row) => {
          const cells = Array.isArray(row) ? row : [row];
          return cells.map((cell) => {
            const value = String(cell ?? "");
            return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
          }).join(",");
        }).join("\n");
        await fs.writeFile(path, csv);
        return { ok: true, content: `Wrote ${args.rows.length} row${args.rows.length === 1 ? "" : "s"} to ${path}.` };
      },
    },
    {
      definition: {
        name: "read_pdf",
        description: "Best-effort PDF text reader. In the current build this reports when native PDF extraction is unavailable.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, max_chars: { type: "number" } }, required: ["path"] },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing PDF path." };
        return { ok: true, content: truncate(await unsupportedBinaryReader("read_pdf", path), args.max_chars) };
      },
    },
    {
      definition: {
        name: "ocr_image",
        description: "Best-effort OCR image reader. In the current build this reports when OCR support is unavailable.",
        inputSchema: { type: "object", properties: { path: { type: "string" }, lang: { type: "string" }, max_chars: { type: "number" } }, required: ["path"] },
      },
      async execute(args) {
        const path = text(args.path ?? args.file_path);
        if (!path) return { ok: false, isError: true, content: "Missing image path." };
        return { ok: true, content: truncate(await unsupportedBinaryReader("ocr_image", path), args.max_chars) };
      },
    },
  ];
}
