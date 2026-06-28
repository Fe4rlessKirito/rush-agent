import { describe, expect, it } from "vitest";

import type { Conversation } from "../../core/store";
import { getVisibleSidebarConversations } from "./Sidebar";

function conversation(
  id: string,
  createdAt: number,
  projectId?: string,
): Conversation {
  return {
    id,
    mode: id.includes("flow") ? "flow" : "agent",
    title: id,
    lines: [],
    createdAt,
    ...(projectId
      ? {
          projectId,
          projectRoot: `C:/work/${projectId}`,
          projectName: projectId,
        }
      : {}),
  };
}

describe("getVisibleSidebarConversations", () => {
  it("shows project-scoped flow chats in global recents", () => {
    const visible = getVisibleSidebarConversations(
      [
        conversation("old-global-agent", 10),
        conversation("new-project-flow", 30, "project-a"),
        conversation("middle-project-agent", 20, "project-b"),
      ],
      null,
    );

    expect(visible.map((c) => c.id)).toEqual([
      "new-project-flow",
      "middle-project-agent",
      "old-global-agent",
    ]);
  });

  it("filters recents to the active project when a project is open", () => {
    const visible = getVisibleSidebarConversations(
      [
        conversation("project-a-flow", 10, "project-a"),
        conversation("project-b-agent", 30, "project-b"),
        conversation("project-a-agent", 20, "project-a"),
        conversation("global-agent", 40),
      ],
      {
        projectId: "project-a",
        projectRoot: "C:/work/project-a",
        projectName: "Project A",
      },
    );

    expect(visible.map((c) => c.id)).toEqual([
      "project-a-agent",
      "project-a-flow",
    ]);
  });
});
