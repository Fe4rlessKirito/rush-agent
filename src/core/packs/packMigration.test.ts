import { describe, expect, it } from "vitest";
import { normalizePackCatalog, normalizeInstalledPack } from "./packMigration";

describe("pack migration", () => {
  it("normalizes old packs missing scope, project ids, and stats fields", () => {
    const catalog = normalizePackCatalog({
      packs: [{
        id: "legacy",
        name: "Legacy",
        enabled: true,
        stats: { accepted: 2 },
        skills: [{ id: "s1", title: "Skill", when: "Use it", how: "Do work" }],
        commands: [{ id: "c1", name: "Review", body: "Read the diff." }],
      }],
    });

    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.packs[0]).toMatchObject({
      id: "legacy",
      scope: "global",
      projectIds: [],
      stats: {
        files: 2,
        accepted: 2,
        rejected: 0,
        skipped: 0,
      },
    });
    expect(catalog.packs[0].commands[0]).toMatchObject({
      name: "review",
      packId: "legacy",
      description: "review",
    });
  });

  it("repairs malformed arrays and preserves project scope", () => {
    const pack = normalizeInstalledPack({
      id: "scoped",
      scope: "projects",
      projectIds: ["p1", "p1", "", "p2"],
      warnings: "bad",
      rejected: null,
      manifests: [{ version: "2", entries: ["a", "a", "b"] }],
    });

    expect(pack.scope).toBe("projects");
    expect(pack.projectIds).toEqual(["p1", "p2"]);
    expect(pack.warnings).toEqual([]);
    expect(pack.rejected).toEqual([]);
    expect(pack.manifests[0]).toMatchObject({
      version: 2,
      entries: ["a", "b"],
      packId: "scoped",
    });
  });
});
