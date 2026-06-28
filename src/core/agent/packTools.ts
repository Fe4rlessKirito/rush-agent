import type {
  InstalledPack,
  PackCatalogCommand,
  PackCatalogManifest,
  PackCatalogRule,
  PackCatalogSkill,
} from "../packs/packCatalog";
import { usePackStore } from "../packs/packStore";
import { useProjectStore } from "../projectStore";
import type { Tool } from "./tools";

export interface PackToolSource {
  listPacks(): InstalledPack[];
  listSkills(): PackCatalogSkill[];
  listCommands(): PackCatalogCommand[];
  listRules(): PackCatalogRule[];
  listManifests(): PackCatalogManifest[];
}

const storeSource: PackToolSource = {
  listPacks: () => usePackStore.getState().getEnabledPacks(useProjectStore.getState().activeProjectId),
  listSkills: () => usePackStore.getState().getEnabledSkills(useProjectStore.getState().activeProjectId),
  listCommands: () => usePackStore.getState().getEnabledCommands(useProjectStore.getState().activeProjectId),
  listRules: () => usePackStore.getState().getEnabledRules(useProjectStore.getState().activeProjectId),
  listManifests: () => {
    const projectId = useProjectStore.getState().activeProjectId;
    return usePackStore.getState().getEnabledPacks(projectId).flatMap((pack) => pack.manifests);
  },
};

type PackItemKind = "skill" | "command" | "rule" | "manifest";

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function matches(value: string, query: string): boolean {
  const q = normalize(query);
  return Boolean(q) && (normalize(value) === q || normalize(value).includes(q));
}

function packLine(pack: InstalledPack): string {
  return [
    `- ${pack.name} (${pack.id})`,
    `${pack.skills.length} skills`,
    `${pack.commands.length} commands`,
    `${pack.rules.length} rules`,
    `${pack.manifests.length} manifests`,
    pack.sourcePath ? `source: ${pack.sourcePath}` : "",
  ].filter(Boolean).join(" | ");
}

function formatList(source: PackToolSource): string {
  const packs = source.listPacks();
  const skills = source.listSkills();
  const commands = source.listCommands();
  const rules = source.listRules();
  const manifests = source.listManifests();
  if (!packs.length) return "No enabled Rush packs are installed.";
  return [
    "# Enabled Rush packs",
    ...packs.map(packLine),
    "",
    "## Skills",
    skills.length ? skills.map((skill) => `- ${skill.title} (${skill.id}) [${skill.tags.join(", ")}]`).join("\n") : "(none)",
    "",
    "## Commands",
    commands.length ? commands.map((command) => `- /${command.name} (${command.id}) - ${command.description}`).join("\n") : "(none)",
    "",
    "## Rules",
    rules.length ? rules.map((rule) => `- ${rule.category ? `${rule.category}: ` : ""}${rule.name} (${rule.id})`).join("\n") : "(none)",
    "",
    "## Manifests",
    manifests.length ? manifests.map((manifest) => `- ${manifest.id}: version ${manifest.version}, ${manifest.entries.length} entries`).join("\n") : "(none)",
  ].join("\n");
}

function findItem(source: PackToolSource, kind: PackItemKind | "", query: string) {
  const kinds: PackItemKind[] = kind ? [kind] : ["skill", "command", "rule", "manifest"];
  for (const candidateKind of kinds) {
    if (candidateKind === "skill") {
      const item = source.listSkills().find((skill) =>
        skill.id === query || matches(skill.title, query) || skill.tags.some((tag) => matches(tag, query)));
      if (item) return { kind: candidateKind, item };
    }
    if (candidateKind === "command") {
      const item = source.listCommands().find((command) =>
        command.id === query || matches(command.name, query) || matches(command.description, query));
      if (item) return { kind: candidateKind, item };
    }
    if (candidateKind === "rule") {
      const item = source.listRules().find((rule) =>
        rule.id === query || matches(rule.name, query) || matches(rule.category ?? "", query));
      if (item) return { kind: candidateKind, item };
    }
    if (candidateKind === "manifest") {
      const item = source.listManifests().find((manifest) =>
        manifest.id === query || manifest.entries.some((entry) => matches(entry, query)));
      if (item) return { kind: candidateKind, item };
    }
  }
  return null;
}

function formatItem(found: NonNullable<ReturnType<typeof findItem>>): string {
  if (found.kind === "skill") {
    const item = found.item as PackCatalogSkill;
    return [
      `Pack skill: ${item.title}`,
      `ID: ${item.id}`,
      `Pack: ${item.packId}`,
      `Origin: ${item.origin}`,
      `Confidence: ${item.confidence}%`,
      item.tags.length ? `Tags: ${item.tags.join(", ")}` : "",
      `When to use: ${item.when}`,
      `How:\n${item.how}`,
    ].filter(Boolean).join("\n");
  }
  if (found.kind === "command") {
    const item = found.item as PackCatalogCommand;
    return [
      `Pack command: /${item.name}`,
      `ID: ${item.id}`,
      `Pack: ${item.packId}`,
      item.description ? `Description: ${item.description}` : "",
      item.argumentHint ? `Arguments: ${item.argumentHint}` : "",
      `Procedure:\n${item.body}`,
    ].filter(Boolean).join("\n");
  }
  if (found.kind === "rule") {
    const item = found.item as PackCatalogRule;
    return [
      `Pack rule: ${item.category ? `${item.category}: ` : ""}${item.name}`,
      `ID: ${item.id}`,
      `Pack: ${item.packId}`,
      `Rule:\n${item.body}`,
    ].join("\n");
  }
  const item = found.item as PackCatalogManifest;
  return [
    `Pack manifest: ${item.id}`,
    `Pack: ${item.packId}`,
    `Version: ${item.version}`,
    "Entries:",
    ...item.entries.map((entry) => `- ${entry}`),
  ].join("\n");
}

function kindArg(value: unknown): PackItemKind | "" {
  const kind = text(value).toLowerCase();
  return kind === "skill" || kind === "command" || kind === "rule" || kind === "manifest" ? kind : "";
}

export function createPackTools(source: PackToolSource = storeSource): Tool[] {
  return [
    {
      definition: {
        name: "PackList",
        description:
          "List enabled imported Rush packs and their available skills, commands, rules, and manifests.",
        inputSchema: { type: "object", properties: {} },
      },
      async execute() {
        return { ok: true, content: formatList(source) };
      },
    },
    {
      definition: {
        name: "PackRead",
        description:
          "Read a specific imported pack item by id, title, command name, rule category, tag, or manifest entry.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Item id, title, command name, rule category, tag, or manifest entry." },
            kind: { type: "string", description: "Optional item kind: skill, command, rule, or manifest." },
          },
          required: ["query"],
        },
      },
      async execute(args) {
        const query = text(args.query ?? args.name ?? args.id);
        if (!query) return { ok: false, isError: true, content: "Missing pack item query." };
        const found = findItem(source, kindArg(args.kind), query);
        if (!found) {
          return {
            ok: false,
            isError: true,
            content: [`Pack item not found: ${query}`, "Available items:", formatList(source)].join("\n\n"),
          };
        }
        return { ok: true, content: formatItem(found) };
      },
    },
  ];
}
