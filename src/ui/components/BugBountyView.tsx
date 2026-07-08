import { useMemo, useState } from "react";
import { parseBugBountyPolicy } from "../../core/bugBountyPolicy";
import { useBugBountyStore, type BugBountyProgramDraft, type BugBountyProgramProfile } from "../../core/bugBountyStore";

function listText(values: string[]): string {
  return values.join("\n");
}

function splitListText(value: string): string[] {
  return value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
}

function headersText(headers: BugBountyProgramDraft["requiredHeaders"]): string {
  return (headers ?? []).map((header) => `${header.name}: ${header.value}`).join("\n");
}

function parseHeadersText(value: string) {
  return value.split(/\r?\n/).map((line) => {
    const index = line.indexOf(":");
    if (index === -1) return { name: line.trim(), value: "" };
    return { name: line.slice(0, index).trim(), value: line.slice(index + 1).trim() };
  }).filter((header) => header.name || header.value);
}

function programSummary(program: BugBountyProgramProfile) {
  return [
    `${program.inScopeAssets.length} in scope`,
    `${program.outOfScopeAssets.length} out of scope`,
    `${program.requiredHeaders.length} required headers`,
  ].join(" - ");
}

export function BugBountyView() {
  const programs = useBugBountyStore((s) => s.programs);
  const activeProgramId = useBugBountyStore((s) => s.activeProgramId);
  const addProgram = useBugBountyStore((s) => s.addProgram);
  const updateProgram = useBugBountyStore((s) => s.updateProgram);
  const deleteProgram = useBugBountyStore((s) => s.deleteProgram);
  const setActiveProgram = useBugBountyStore((s) => s.setActiveProgram);
  const activeProgram = useMemo(
    () => programs.find((program) => program.id === activeProgramId) ?? programs[0] ?? null,
    [activeProgramId, programs],
  );
  const [policyText, setPolicyText] = useState("");
  const [draft, setDraft] = useState<BugBountyProgramDraft | null>(null);
  const [draftFields, setDraftFields] = useState({
    name: "",
    programUrl: "",
    researcherHandle: "",
    inScopeAssets: "",
    outOfScopeAssets: "",
    requiredHeaders: "",
    excludedVulnerabilityClasses: "",
    notes: "",
  });

  function parsePolicy() {
    const next = parseBugBountyPolicy(policyText);
    setDraft(next);
    setDraftFields({
      name: next.name ?? "",
      programUrl: next.programUrl ?? "",
      researcherHandle: next.researcherHandle ?? "",
      inScopeAssets: listText(next.inScopeAssets ?? []),
      outOfScopeAssets: listText(next.outOfScopeAssets ?? []),
      requiredHeaders: headersText(next.requiredHeaders),
      excludedVulnerabilityClasses: listText(next.excludedVulnerabilityClasses ?? []),
      notes: next.notes ?? "",
    });
  }

  function saveDraft() {
    if (!draft) return;
    const id = addProgram({
      ...draft,
      name: draftFields.name,
      programUrl: draftFields.programUrl,
      researcherHandle: draftFields.researcherHandle,
      inScopeAssets: splitListText(draftFields.inScopeAssets),
      outOfScopeAssets: splitListText(draftFields.outOfScopeAssets),
      requiredHeaders: parseHeadersText(draftFields.requiredHeaders),
      excludedVulnerabilityClasses: splitListText(draftFields.excludedVulnerabilityClasses),
      notes: draftFields.notes,
      policyText,
    });
    setActiveProgram(id);
  }

  return (
    <main className="bug-bounty-view">
      <section className="bug-bounty-panel bug-bounty-programs">
        <div className="bug-bounty-head">
          <span>Bug Bounty</span>
          <small>Authorized program profiles only</small>
        </div>
        {programs.length === 0 ? (
          <div className="bug-bounty-empty">Paste a program policy to create your first profile.</div>
        ) : (
          <div className="bug-bounty-list">
            {programs.map((program) => (
              <button
                key={program.id}
                type="button"
                className={program.id === activeProgram?.id ? "active" : ""}
                onClick={() => setActiveProgram(program.id)}
                title={program.programUrl}
              >
                <strong>{program.name}</strong>
                <span>{program.platform}</span>
                <small>{programSummary(program)}</small>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="bug-bounty-panel bug-bounty-import">
        <div className="bug-bounty-head">
          <span>Import policy</span>
          <small>Paste HackerOne/Bugcrowd/Intigriti scope text</small>
        </div>
        <textarea
          value={policyText}
          onChange={(event) => setPolicyText(event.target.value)}
          placeholder="Paste the program policy and scope here..."
        />
        <div className="bug-bounty-actions">
          <button type="button" onClick={parsePolicy} disabled={!policyText.trim()}>
            Parse policy
          </button>
          <button type="button" onClick={saveDraft} disabled={!draft}>
            Save profile
          </button>
        </div>
        <p className="bug-bounty-safety">
          Rush will only store and review scope here. Active testing and scanners are not run from this view.
        </p>
      </section>

      <section className="bug-bounty-panel bug-bounty-details">
        <div className="bug-bounty-head">
          <span>{draft ? "Review parsed draft" : "Active profile"}</span>
          {activeProgram && !draft && <small>{activeProgram.updatedAt ? new Date(activeProgram.updatedAt).toLocaleString() : "Saved profile"}</small>}
        </div>
        {draft ? (
          <div className="bug-bounty-form">
            <label>
              Program name
              <input value={draftFields.name} onChange={(event) => setDraftFields((fields) => ({ ...fields, name: event.target.value }))} />
            </label>
            <label>
              Program URL
              <input value={draftFields.programUrl} onChange={(event) => setDraftFields((fields) => ({ ...fields, programUrl: event.target.value }))} />
            </label>
            <label>
              Researcher handle
              <input value={draftFields.researcherHandle} onChange={(event) => setDraftFields((fields) => ({ ...fields, researcherHandle: event.target.value }))} />
            </label>
            <label>
              In-scope assets
              <textarea value={draftFields.inScopeAssets} onChange={(event) => setDraftFields((fields) => ({ ...fields, inScopeAssets: event.target.value }))} />
            </label>
            <label>
              Out-of-scope assets
              <textarea value={draftFields.outOfScopeAssets} onChange={(event) => setDraftFields((fields) => ({ ...fields, outOfScopeAssets: event.target.value }))} />
            </label>
            <label>
              Required headers
              <textarea value={draftFields.requiredHeaders} onChange={(event) => setDraftFields((fields) => ({ ...fields, requiredHeaders: event.target.value }))} />
            </label>
            <label>
              Excluded vulnerability classes
              <textarea value={draftFields.excludedVulnerabilityClasses} onChange={(event) => setDraftFields((fields) => ({ ...fields, excludedVulnerabilityClasses: event.target.value }))} />
            </label>
            <label>
              Notes
              <textarea value={draftFields.notes} onChange={(event) => setDraftFields((fields) => ({ ...fields, notes: event.target.value }))} />
            </label>
          </div>
        ) : activeProgram ? (
          <div className="bug-bounty-profile">
            <h2>{activeProgram.name}</h2>
            <p>{activeProgram.programUrl || "No program URL saved."}</p>
            <div className="bug-bounty-grid">
              <div><strong>Platform</strong><span>{activeProgram.platform}</span></div>
              <div><strong>Researcher</strong><span>{activeProgram.researcherHandle || "Not set"}</span></div>
              <div><strong>In scope</strong><span>{activeProgram.inScopeAssets.length}</span></div>
              <div><strong>Out of scope</strong><span>{activeProgram.outOfScopeAssets.length}</span></div>
            </div>
            <h3>In-scope assets</h3>
            <pre>{activeProgram.inScopeAssets.join("\n") || "None saved"}</pre>
            <h3>Out-of-scope assets</h3>
            <pre>{activeProgram.outOfScopeAssets.join("\n") || "None saved"}</pre>
            <h3>Required headers</h3>
            <pre>{headersText(activeProgram.requiredHeaders) || "None saved"}</pre>
            <h3>Notes</h3>
            <pre>{activeProgram.notes || "No notes"}</pre>
            <div className="bug-bounty-actions">
              <button type="button" onClick={() => deleteProgram(activeProgram.id)}>Delete profile</button>
              <button type="button" onClick={() => updateProgram(activeProgram.id, { updatedAt: undefined } as never)}>Mark reviewed</button>
            </div>
          </div>
        ) : (
          <div className="bug-bounty-empty">No active profile yet.</div>
        )}
      </section>
    </main>
  );
}
