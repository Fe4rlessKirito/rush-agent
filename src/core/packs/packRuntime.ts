import { usePackStore } from "./packStore";
import type { PackCatalogCommand } from "./packCatalog";
import { useProjectStore } from "../projectStore";

export type PackRuntimeMode = "plain" | "agent" | "flow";

function truncate(value: string, max: number): string {
  const clean = value.trim();
  return clean.length > max ? `${clean.slice(0, max).trimEnd()}...` : clean;
}

function activeProjectId(projectId?: string | null): string | null {
  return projectId === undefined ? useProjectStore.getState().activeProjectId : projectId;
}

function commandSection(projectId?: string | null) {
  const commands = usePackStore.getState().getEnabledCommands(projectId).slice(0, 12);
  if (!commands.length) return "";
  return [
    "## Imported pack commands",
    "These are reusable command procedures from enabled packs. Apply one when the user explicitly asks for it or when it clearly matches the task.",
    ...commands.map((command) => [
      `### /${command.name}`,
      command.description ? `Description: ${command.description}` : "",
      command.argumentHint ? `Arguments: ${command.argumentHint}` : "",
      `Procedure:\n${truncate(command.body, 1400)}`,
    ].filter(Boolean).join("\n")),
  ].join("\n\n");
}

function ruleSection(projectId?: string | null) {
  const rules = usePackStore.getState().getEnabledRules(projectId).slice(0, 20);
  if (!rules.length) return "";
  return [
    "## Imported pack rules",
    "Follow these enabled pack rules when they are relevant to the current task and do not conflict with higher-priority instructions.",
    ...rules.map((rule) => [
      `### ${rule.category ? `${rule.category}: ` : ""}${rule.name}`,
      truncate(rule.body, 1200),
    ].join("\n")),
  ].join("\n\n");
}

export function buildPackRuntimeContext(mode: PackRuntimeMode, projectId?: string | null): string {
  if (mode === "plain") return "";
  const resolvedProjectId = activeProjectId(projectId);
  const sections = [commandSection(resolvedProjectId), ruleSection(resolvedProjectId)].filter(Boolean);
  if (!sections.length) return "";
  return [
    "# Enabled pack context",
    "This context comes from user-imported Rush packs. Treat it as reusable workflow guidance, not as user text.",
    ...sections,
  ].join("\n\n");
}

export interface PackCommandInvocation {
  command: PackCatalogCommand;
  name: string;
  args: string;
  context: string;
}

function parseSlashInvocation(userText: string): { name: string; args: string } | null {
  const match = userText.trim().match(/^\/([A-Za-z0-9_.-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return {
    name: match[1].trim(),
    args: (match[2] ?? "").trim(),
  };
}

function normalizeCommandName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-|-$/g, "");
}

export function resolvePackCommandInvocation(userText: string, mode: PackRuntimeMode, projectId?: string | null): PackCommandInvocation | null {
  if (mode === "plain") return null;
  const parsed = parseSlashInvocation(userText);
  if (!parsed) return null;
  const commandName = normalizeCommandName(parsed.name);
  const command = usePackStore.getState().getEnabledCommands(activeProjectId(projectId)).find((item) =>
    normalizeCommandName(item.name) === commandName ||
    normalizeCommandName(item.id.split(":").pop() ?? "") === commandName);
  if (!command) return null;
  const context = [
    "# Invoked pack command",
    `The user explicitly invoked /${command.name}. Apply this imported pack command procedure to the current turn.`,
    `Command: /${command.name}`,
    command.description ? `Description: ${command.description}` : "",
    command.argumentHint ? `Expected arguments: ${command.argumentHint}` : "",
    parsed.args ? `User arguments:\n${parsed.args}` : "User arguments: (none provided)",
    `Procedure:\n${command.body}`,
  ].filter(Boolean).join("\n\n");
  return {
    command,
    name: command.name,
    args: parsed.args,
    context,
  };
}

export function userTextWithPackCommandInvocation(userText: string, invocation: PackCommandInvocation | null): string {
  if (!invocation) return userText;
  return [
    invocation.context,
    "",
    "Original user message:",
    userText.trim(),
  ].join("\n");
}

export function suggestPackCommands(userText: string, mode: PackRuntimeMode, limit = 6, projectId?: string | null): PackCatalogCommand[] {
  if (mode === "plain") return [];
  const trimmed = userText.trimStart();
  const match = trimmed.match(/^\/([A-Za-z0-9_.-]*)/);
  if (!match) return [];
  const query = normalizeCommandName(match[1] ?? "");
  return usePackStore.getState()
    .getEnabledCommands(activeProjectId(projectId))
    .filter((command) => !query || normalizeCommandName(command.name).includes(query))
    .sort((a, b) => {
      const an = normalizeCommandName(a.name);
      const bn = normalizeCommandName(b.name);
      const aStarts = query && an.startsWith(query) ? 0 : 1;
      const bStarts = query && bn.startsWith(query) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(1, Math.min(12, limit)));
}
