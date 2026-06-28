import { type CSSProperties, useMemo, useRef, useState } from "react";
import { useBrainStore, type MemoryKind, type BrainMemory, type BrainSkill } from "../../core/brainStore";
import { useDraggable } from "../hooks/useDraggable";

type BrainTab = "memories" | "skills" | "add" | "settings";
type MemorySort = "newest" | "oldest" | "kind";
type SkillSort = "confidence" | "newest" | "title";

const memoryKinds: MemoryKind[] = ["fact", "preference", "instruction", "note"];
const brainTabs = [
  ["memories", "memory", "Memories"],
  ["skills", "skill", "Skills"],
  ["add", "add", "Add"],
  ["settings", "settings", "Settings"],
] as const;

function Icon({ name }: { name: "brain" | "memory" | "skill" | "add" | "settings" | "import" | "export" | "search" | "spark" }) {
  const common = { fill: "none", stroke: "currentColor", strokeWidth: 1.9, strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {name === "brain" && (
        <>
          <path {...common} d="M9 4.5a3.5 3.5 0 0 0-4 3.45A3.8 3.8 0 0 0 3.5 11a3.7 3.7 0 0 0 1.1 2.63A3.5 3.5 0 0 0 8 19.5" />
          <path {...common} d="M15 4.5a3.5 3.5 0 0 1 4 3.45A3.8 3.8 0 0 1 20.5 11a3.7 3.7 0 0 1-1.1 2.63A3.5 3.5 0 0 1 16 19.5" />
          <path {...common} d="M9 4.5v15M15 4.5v15M9 9h6M9 14h6" />
        </>
      )}
      {name === "memory" && <path {...common} d="M12 21s7-4.35 7-11a7 7 0 0 0-14 0c0 6.65 7 11 7 11Z" />}
      {name === "skill" && <path {...common} d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" />}
      {name === "add" && <><circle {...common} cx="12" cy="12" r="8" /><path {...common} d="M12 8v8M8 12h8" /></>}
      {name === "settings" && <><circle {...common} cx="12" cy="12" r="3" /><path {...common} d="M19 12a7 7 0 0 0-.08-1l2-1.5-2-3.46-2.35.95a7.3 7.3 0 0 0-1.74-1L14.5 3h-5l-.34 2.98a7.3 7.3 0 0 0-1.74 1l-2.35-.95-2 3.46 2 1.5A7 7 0 0 0 5 12a7 7 0 0 0 .08 1l-2 1.5 2 3.46 2.35-.95a7.3 7.3 0 0 0 1.74 1L9.5 21h5l.34-2.98a7.3 7.3 0 0 0 1.74-1l2.35.95 2-3.46-2-1.5A7 7 0 0 0 19 12Z" /></>}
      {name === "import" && <><path {...common} d="M12 3v11" /><path {...common} d="m8 10 4 4 4-4" /><path {...common} d="M5 19h14" /></>}
      {name === "export" && <><path {...common} d="M12 15V4" /><path {...common} d="m8 8 4-4 4 4" /><path {...common} d="M5 19h14" /></>}
      {name === "search" && <><circle {...common} cx="10.5" cy="10.5" r="5.5" /><path {...common} d="m15 15 4 4" /></>}
      {name === "spark" && <path {...common} d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />}
    </svg>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="brain-toggle">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function parseImport(text: string): { memories: Array<{ text: string; kind?: MemoryKind }>; skills: Array<Partial<BrainSkill>> } {
  try {
    const json = JSON.parse(text);
    if (Array.isArray(json)) return { memories: json.map((item) => ({ text: String(item.text ?? item) })), skills: [] };
    return {
      memories: Array.isArray(json.memories) ? json.memories : [],
      skills: Array.isArray(json.skills) ? json.skills : [],
    };
  } catch {
    return {
      memories: text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({ text: line })),
      skills: [],
    };
  }
}

function downloadJson(filename: string, payload: unknown) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function BrainView({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<BrainTab>("memories");
  const [memorySearch, setMemorySearch] = useState("");
  const [skillSearch, setSkillSearch] = useState("");
  const [memorySort, setMemorySort] = useState<MemorySort>("newest");
  const [skillSort, setSkillSort] = useState<SkillSort>("confidence");
  const [memoryText, setMemoryText] = useState("");
  const [memoryKind, setMemoryKind] = useState<MemoryKind>("fact");
  const [skillUrl, setSkillUrl] = useState("");
  const [skillTitle, setSkillTitle] = useState("");
  const [skillWhen, setSkillWhen] = useState("");
  const [skillHow, setSkillHow] = useState("");
  const [skillTags, setSkillTags] = useState("");
  const [skillImportStatus, setSkillImportStatus] = useState("");
  const importRef = useRef<HTMLInputElement | null>(null);
  const { onMouseDown, style } = useDraggable(".brain-shell");
  const tabIndex = Math.max(0, brainTabs.findIndex(([id]) => id === tab));

  const {
    memories,
    skills,
    memoriesEnabled,
    skillsEnabled,
    autoExtractMemories,
    autoExtractSkills,
    autoApproveSkills,
    minimumConfidence,
    maxInjectedSkills,
    addMemory,
    addSkill,
    importMemories,
    importSkills,
    setBrainSetting,
    tidyMemories,
    auditSkills,
  } = useBrainStore();

  const shownMemories = useMemo(() => {
    const q = memorySearch.trim().toLowerCase();
    return memories
      .filter((m) => !q || m.text.toLowerCase().includes(q) || m.kind.includes(q))
      .sort((a, b) => {
        if (memorySort === "oldest") return a.createdAt - b.createdAt;
        if (memorySort === "kind") return a.kind.localeCompare(b.kind) || b.createdAt - a.createdAt;
        return b.createdAt - a.createdAt;
      });
  }, [memories, memorySearch, memorySort]);

  const shownSkills = useMemo(() => {
    const q = skillSearch.trim().toLowerCase();
    return skills
      .filter((s) => !q || [s.title, s.when, s.how, s.tags.join(" ")].join(" ").toLowerCase().includes(q))
      .sort((a, b) => {
        if (skillSort === "newest") return b.createdAt - a.createdAt;
        if (skillSort === "title") return a.title.localeCompare(b.title);
        return b.confidence - a.confidence;
      });
  }, [skills, skillSearch, skillSort]);

  const onImportFile = async (file: File) => {
    const text = await file.text();
    const parsed = parseImport(text);
    importMemories(parsed.memories);
    importSkills(parsed.skills);
  };

  const submitMemory = () => {
    addMemory(memoryText, memoryKind);
    setMemoryText("");
  };

  const submitSkill = () => {
    addSkill({
      title: skillTitle,
      when: skillWhen,
      how: skillHow,
      tags: skillTags.split(",").map((tag) => tag.trim()).filter(Boolean),
    });
    setSkillTitle("");
    setSkillWhen("");
    setSkillHow("");
    setSkillTags("");
  };

  const importSkillUrl = async () => {
    const url = skillUrl.trim();
    if (!url) return;
    setSkillImportStatus("Importing...");
    try {
      const res = await fetch(url);
      const text = res.ok ? await res.text() : "";
      const title = url.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") || "Imported skill";
      addSkill({
        title,
        when: `Use when this imported workflow is relevant: ${url}`,
        how: text.trim() || `Imported skill reference: ${url}`,
        tags: ["imported"],
      });
      setSkillUrl("");
      setSkillImportStatus("Imported");
    } catch {
      const title = url.split("/").filter(Boolean).pop()?.replace(/[-_]+/g, " ") || "Imported skill";
      addSkill({
        title,
        when: `Use when this imported workflow is relevant: ${url}`,
        how: `Imported skill reference: ${url}`,
        tags: ["imported"],
      });
      setSkillUrl("");
      setSkillImportStatus("Saved as URL reference");
    }
  };

  return (
    <div className="brain-overlay" onMouseDown={onClose}>
      <input
        ref={importRef}
        hidden
        type="file"
        accept=".txt,.md,.pdf,.csv,.log,.json,.py,.js,.html,.skill,.sh"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onImportFile(file);
          e.target.value = "";
        }}
      />
      <section className="brain-shell" style={style} onMouseDown={(e) => e.stopPropagation()}>
        <div className="brain-window-title" onMouseDown={onMouseDown}>
          <div className="brain-brand"><Icon name="brain" /><span>Brain</span></div>
          <div className="brain-window-actions">
            <button onClick={onClose} title="Minimize Brain" aria-label="Minimize Brain">-</button>
            <button onClick={onClose} title="Close Brain" aria-label="Close Brain">x</button>
          </div>
        </div>

        <nav
          className="brain-tabs"
          aria-label="Brain sections"
          style={{ "--brain-tab-index": tabIndex } as CSSProperties}
        >
          {brainTabs.map(([id, icon, label]) => (
            <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id as BrainTab)}>
              <Icon name={icon as "memory" | "skill" | "add" | "settings"} />
              <span>{id === "memories" ? `${label} ${memories.length}` : id === "skills" ? `${label} ${skills.length}` : label}</span>
            </button>
          ))}
        </nav>

        <div key={tab} className="brain-tab-content">
        {tab === "memories" && (
          <div className="brain-card">
            <div className="brain-card-head">
              <h2><Icon name="memory" /> Memories <small>{memories.length} memories</small></h2>
              <Toggle checked={memoriesEnabled} onChange={(v) => setBrainSetting("memoriesEnabled", v)} label="Enabled" />
            </div>
            <p>Long-term facts the AI remembers across chats: recall, edit, or curate.</p>
            <div className="brain-toolbar">
              <select value={memorySort} onChange={(e) => setMemorySort(e.target.value as MemorySort)}>
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="kind">Type</option>
              </select>
              <button onClick={tidyMemories}><Icon name="spark" /> Tidy</button>
              <button disabled>Select</button>
            </div>
            <label className="brain-search"><Icon name="search" /><input value={memorySearch} onChange={(e) => setMemorySearch(e.target.value)} placeholder="Search memories..." /></label>
            <div className="brain-list">
              {shownMemories.length ? shownMemories.map((memory) => <MemoryRow key={memory.id} memory={memory} />) : (
                <div className="brain-empty">
                  <span>No memories yet.</span>
                  <button onClick={() => setTab("add")}>Import in Add tab</button>
                </div>
              )}
            </div>
          </div>
        )}

        {tab === "skills" && (
          <div className="brain-card">
            <div className="brain-card-head">
              <h2><Icon name="skill" /> Skills <small>{skills.length} skills</small></h2>
              <Toggle checked={skillsEnabled} onChange={(v) => setBrainSetting("skillsEnabled", v)} label="Enabled" />
            </div>
            <p>Reusable procedures the AI can call via /skill, sorted by confidence to surface proven workflows.</p>
            <div className="brain-toolbar">
              <select value={skillSort} onChange={(e) => setSkillSort(e.target.value as SkillSort)}>
                <option value="confidence">Confidence</option>
                <option value="newest">Newest</option>
                <option value="title">Title</option>
              </select>
              <button onClick={auditSkills}><Icon name="spark" /> Audit</button>
              <button disabled>Select</button>
            </div>
            <label className="brain-search"><Icon name="search" /><input value={skillSearch} onChange={(e) => setSkillSearch(e.target.value)} placeholder="Search skills..." /></label>
            <div className="brain-list">
              {shownSkills.length ? shownSkills.map((skill) => <SkillRow key={skill.id} skill={skill} />) : (
                <div className="brain-empty"><span>No skills yet, use agent for it to auto extract them.</span></div>
              )}
            </div>
          </div>
        )}

        {tab === "add" && (
          <div className="brain-add">
            <div className="brain-card">
              <div className="brain-card-head">
                <h2><Icon name="memory" /> Add Memory</h2>
                <div className="brain-action-row">
                  <button onClick={() => importRef.current?.click()}><Icon name="import" /> Import</button>
                  <button onClick={() => downloadJson("rush-brain.json", { memories, skills })}><Icon name="export" /> Export</button>
                </div>
              </div>
              <p>Import text, markdown, logs, JSON, or code. Rush stores candidate memories you approve.</p>
              <div className="brain-inline-form">
                <input value={memoryText} onChange={(e) => setMemoryText(e.target.value)} placeholder="Add a memory, e.g. I prefer concise replies" />
                <select value={memoryKind} onChange={(e) => setMemoryKind(e.target.value as MemoryKind)}>
                  {memoryKinds.map((kind) => <option key={kind} value={kind}>{kind}</option>)}
                </select>
                <button onClick={submitMemory} disabled={!memoryText.trim()}>Add</button>
              </div>
            </div>

            <div className="brain-card">
              <div className="brain-card-head">
                <h2><Icon name="skill" /> Add Skill</h2>
              </div>
              <p>Import a skill from a GitHub or skills.sh folder, or create a skill by hand.</p>
              <div className="brain-inline-form">
                <input value={skillUrl} onChange={(e) => setSkillUrl(e.target.value)} placeholder="Import URL, e.g. GitHub tree link to a skill folder" />
                <button onClick={importSkillUrl} disabled={!skillUrl.trim()}><Icon name="import" /> Import</button>
              </div>
              {skillImportStatus && <small className="brain-form-status">{skillImportStatus}</small>}
              <p className="brain-form-copy">Or create a skill by hand — title, what it solves, and an approach.</p>
              <div className="brain-skill-form">
                <input value={skillTitle} onChange={(e) => setSkillTitle(e.target.value)} placeholder="Title, e.g. build-vllm-wheel" />
                <input value={skillWhen} onChange={(e) => setSkillWhen(e.target.value)} placeholder="When to use: what problem does this skill solve?" />
                <textarea value={skillHow} onChange={(e) => setSkillHow(e.target.value)} placeholder="How: approach, steps, commands, or rules to follow" />
                <input value={skillTags} onChange={(e) => setSkillTags(e.target.value)} placeholder="Tags: comma-separated, e.g. python, build, vllm" />
                <button onClick={submitSkill} disabled={!skillTitle.trim() || !skillWhen.trim() || !skillHow.trim()}>Add Skill</button>
              </div>
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div className="brain-settings">
            <SettingCard title="Auto-extract memories" text="Automatically extract memories from conversations." checked={autoExtractMemories} onChange={(v) => setBrainSetting("autoExtractMemories", v)} />
            <SettingCard title="Auto-extract skills" text="Automatically draft reusable skills from workflows. Audit can publish passing skills; cleanup retires weak or duplicate skills only after review." checked={autoExtractSkills} onChange={(v) => setBrainSetting("autoExtractSkills", v)} />
            <div className="brain-card setting-card">
              <div className="brain-card-head">
                <h2><Icon name="spark" /> Auto-approve skills</h2>
                <Toggle checked={autoApproveSkills} onChange={(v) => setBrainSetting("autoApproveSkills", v)} label="" />
              </div>
              <p>Audit publishes passing, necessary skills at or above this confidence. Off keeps audit results as drafts unless manually approved.</p>
              <label className="brain-range">
                <span>Minimum confidence</span>
                <input
                  className="brain-percent-input"
                  type="number"
                  min="50"
                  max="100"
                  value={minimumConfidence}
                  onChange={(e) => {
                    const next = Math.max(50, Math.min(100, Number(e.target.value) || 50));
                    setBrainSetting("minimumConfidence", next);
                  }}
                  aria-label="Minimum confidence percentage"
                />
                <input
                  className="brain-confidence-slider"
                  type="range"
                  min="50"
                  max="100"
                  value={minimumConfidence}
                  style={{ "--confidence-fill": `${((minimumConfidence - 50) / 50) * 100}%` } as CSSProperties}
                  onChange={(e) => setBrainSetting("minimumConfidence", Number(e.target.value))}
                />
              </label>
            </div>
            <div className="brain-card setting-card">
              <div className="brain-card-head"><h2><Icon name="import" /> Inject Skills</h2></div>
              <p>Controls how many relevant published or approved skills are added to each agent request.</p>
              <label className="brain-number">
                <span>Max skills per request</span>
                <input type="number" min="0" max="20" value={maxInjectedSkills} onChange={(e) => setBrainSetting("maxInjectedSkills", Number(e.target.value))} />
              </label>
              <small>Set to 0 to disable skill injection.</small>
            </div>
          </div>
        )}
        </div>
      </section>
    </div>
  );
}

function MemoryRow({ memory }: { memory: BrainMemory }) {
  return (
    <article className="brain-row">
      <div><strong>{memory.text}</strong><span>{new Date(memory.createdAt).toLocaleString()}</span></div>
      <em>{memory.kind}</em>
    </article>
  );
}

function SkillRow({ skill }: { skill: BrainSkill }) {
  return (
    <article className="brain-row skill-row">
      <div>
        <strong>{skill.title}</strong>
        <span>{skill.when}</span>
      </div>
      <em>{skill.confidence}%</em>
    </article>
  );
}

function SettingCard({ title, text, checked, onChange }: { title: string; text: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="brain-card setting-card">
      <div className="brain-card-head">
        <h2><Icon name="spark" /> {title}</h2>
        <Toggle checked={checked} onChange={onChange} label="" />
      </div>
      <p>{text}</p>
    </div>
  );
}
