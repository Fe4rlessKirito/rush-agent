import { ProviderRegistry, createProvider } from "../../core/providers/registry";
import { modelDisplayName } from "../../core/providers/modelGroups";
import { useAppStore } from "../../core/store";
import { useProjectStore } from "../../core/projectStore";
import { useResearchStore } from "../../core/researchStore";
import { useBrainStore } from "../../core/brainStore";
import { ToolRegistry, type Tool } from "../../core/agent/tools";
import { createFsTools } from "../../core/agent/fsTools";
import { createDevFs } from "../../core/agent/devFs";
import { createTauriFs, isTauriRuntime } from "../../core/agent/tauriFs";
import { createCodeTools } from "../../core/agent/codeTools";
import { createGitTools } from "../../core/agent/gitTools";
import { createPackageTools } from "../../core/agent/packageTools";
import { createTerminalTools } from "../../core/agent/terminalTools";
import { createBackgroundTools } from "../../core/agent/backgroundTools";
import { createWebTools } from "../../core/agent/webTools";
import { createChatTools } from "../../core/agent/chatTools";
import { createFlowTools } from "../../core/agent/flowTools";
import { createPlanningTools } from "../../core/agent/planningTools";
import { createWorktreeTools } from "../../core/agent/worktreeTools";
import { createSkillTools } from "../../core/agent/skillTools";
import { createPackTools } from "../../core/agent/packTools";
import { createMcpTools } from "../../core/agent/mcpTools";
import { createProjectTools } from "../../core/agent/projectTools";
import { createReleaseTools } from "../../core/agent/releaseTools";
import { createBrowserTools } from "../../core/agent/browserTools";
import { createMemoryTools } from "../../core/agent/memoryTools";
import { createRagTools } from "../../core/agent/ragTools";
import { createDocumentTools } from "../../core/agent/documentTools";
import { createSplitUpTools } from "../../core/agent/splitUpTools";
import { createGithubTools } from "../../core/agent/githubTools";
import { createDynamicMcpTools, createMcpConfigTools, mcpRuntimeSource } from "../../core/agent/mcpRuntime";
import { isToolAvailableInMode } from "../../core/agent/toolModes";
import { describeToolCall, describeToolResult } from "./chatPanelHelpers";

export type ModeSwitchHandler = (mode: "plain" | "agent", reason: string) => Promise<string>;

let handleModeSwitchRequest: ModeSwitchHandler | null = null;

export function setModeSwitchHandler(handler: ModeSwitchHandler | null) {
  handleModeSwitchRequest = handler;
}

function modeLabel(mode: "plain" | "agent"): string {
  return mode === "agent" ? "Code" : "Chat";
}

function registerCodeToolset(registry: ToolRegistry, mode: "code" | "flow") {
  registry.registerAll(createFsTools(fs));
  registry.registerAll(createCodeTools());
  registry.registerAll(createGitTools());
  registry.registerAll(createPackageTools());
  registry.registerAll(createTerminalTools());
  registry.registerAll(createBackgroundTools());
  registry.registerAll(createWebTools({ getSearchConfig: () => useResearchStore.getState().searchConfig }));
  registry.registerAll(createPlanningTools());
  registry.registerAll(createWorktreeTools());
  registry.registerAll(createSkillTools());
  registry.registerAll(createPackTools());
  registry.registerAll(createMcpTools(mcpRuntimeSource));
  registry.registerAll(createMcpConfigTools());
  registry.registerAll(createReleaseTools(fs));
  registry.registerAll(createBrowserTools());
  registry.registerAll(createMemoryTools());
  registry.registerAll(createRagTools());
  registry.registerAll(createDocumentTools(fs));
  registry.registerAll(createGithubTools());
  registry.registerAll(createSplitUpTools({
    getProvider: () => {
      const state = useAppStore.getState();
      if (!state.activeProviderId) throw new Error("No active provider selected.");
      return new ProviderRegistry(state.providers).get(state.activeProviderId);
    },
    getModel: () => {
      const state = useAppStore.getState();
      if (!state.activeModel) throw new Error("No active model selected.");
      return state.activeModel;
    },
    getTools: () => registry,
    getProjectInstructions: () => {
      const state = useProjectStore.getState();
      return state.projects.find((p) => p.id === state.activeProjectId)?.instructions ?? "";
    },
  }));
  registry.registerAll(createProjectTools({
    getContext: () => {
      const projectState = useProjectStore.getState();
      const project = projectState.projects.find((item) => item.id === projectState.activeProjectId);
      return {
        mode,
        activeProjectId: projectState.activeProjectId,
        projectName: project?.name,
        projectPath: project?.path,
        instructions: project?.instructions,
      };
    },
  }));
  registry.registerDynamic(() => createDynamicMcpTools());
}

const fs = isTauriRuntime() ? createTauriFs() : createDevFs();

const suggestModeSwitchTool: Tool = {
  definition: {
    name: "suggest_mode_switch",
    description:
      "Propose switching this conversation's current mode between Chat and Code. Use this when the task needs capabilities the current mode doesn't have — e.g. you're in Chat and the user needs you to read/edit project files, run commands, or use Git, or you're in Code and a purely conversational request would be better served without file/tool access. Switching to Code mode may apply automatically when permissions are Full access; otherwise the user sees your proposed mode and reason, and must explicitly confirm before it takes effect.",
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["plain", "agent"], description: "\"agent\" for Code mode, \"plain\" for Chat mode." },
        reason: { type: "string", description: "One short sentence explaining why this mode is a better fit for the current request." },
      },
      required: ["mode", "reason"],
    },
  },
  execute: async (args) => {
    const mode = args.mode === "plain" ? "plain" : "agent";
    const reason = String(args.reason ?? "");
    const result = await handleModeSwitchRequest?.(mode, reason);
    return { ok: true, content: result ?? `Mode switch to ${modeLabel(mode)} mode could not be handled by the UI.` };
  },
};

export const codeTools = new ToolRegistry({
  isToolEnabled: (name) => isToolAvailableInMode("code", name),
});
registerCodeToolset(codeTools, "code");
codeTools.registerAll(createFlowTools({
  getProvider: () => {
    const state = useAppStore.getState();
    if (!state.activeProviderId) throw new Error("No active provider selected.");
    return new ProviderRegistry(state.providers).get(state.activeProviderId);
  },
  getModel: () => {
    const state = useAppStore.getState();
    if (!state.activeModel) throw new Error("No active model selected.");
    return state.activeModel;
  },
  getTools: () => codeTools,
  getProjectInstructions: () => {
    const state = useProjectStore.getState();
    return state.projects.find((p) => p.id === state.activeProjectId)?.instructions ?? "";
  },
  getSubagents: () => {
    const state = useAppStore.getState();
    const parentId = state.activeConversationId || state.activeConversationIds.chat || "pending";
    return state.subagentRuns
      .filter((run) => run.parentConversationId === parentId)
      .map((run) => ({ id: run.id, title: run.title, task: run.task, status: run.status }));
  },
  getSubagentMessages: (id) => useAppStore.getState().subagentRuns.find((run) => run.id === id)?.messages ?? [],
  onSubagentStart: ({ task, title }) => {
    const state = useAppStore.getState();
    return state.startSubagentRun({
      parentConversationId: state.activeConversationId || state.activeConversationIds.chat || "pending",
      task,
      title,
      coordinator: state.activeModel ? `${modelDisplayName(state.activeModel)} Coordinator` : "Rush Coordinator",
      projectContext: state.conversationProjectContext,
    });
  },
  onSubagentEvent: (id, event) => {
    if (!id) return;
    const state = useAppStore.getState();
    if (event.type === "text" && event.text) {
      state.appendSubagentText(id, { text: event.text });
    } else if (event.type === "thinking" && event.text) {
      state.appendSubagentText(id, { thinking: event.text });
    } else if (event.type === "tool_call") {
      if (event.toolName) state.addSubagentToolName(id, event.toolName);
      state.appendSubagentLine(id, { role: "tool", text: describeToolCall(event.toolName, event.toolArgs) });
      state.appendSubagentLine(id, { role: "agent", text: "", meta: { speaker: state.activeModel ? modelDisplayName(state.activeModel) : "Rush", model: state.activeModel ?? undefined, modelLabel: state.activeModel ? modelDisplayName(state.activeModel) : "Rush", providerId: state.activeProviderId ?? undefined, providerLabel: state.providers.find((item) => item.id === state.activeProviderId)?.label, startedAt: Date.now() } });
    } else if (event.type === "tool_result") {
      state.appendSubagentLine(id, { role: "tool", text: describeToolResult(event.toolName, event.toolResult) });
      state.appendSubagentLine(id, { role: "agent", text: "", meta: { speaker: state.activeModel ? modelDisplayName(state.activeModel) : "Rush", model: state.activeModel ?? undefined, modelLabel: state.activeModel ? modelDisplayName(state.activeModel) : "Rush", providerId: state.activeProviderId ?? undefined, providerLabel: state.providers.find((item) => item.id === state.activeProviderId)?.label, startedAt: Date.now() } });
    } else if (event.type === "error") {
      state.appendSubagentLine(id, { role: "tool", text: `Error: ${event.text ?? "Subagent failed."}` });
    }
  },
  onSubagentDone: (id, status) => {
    if (id) useAppStore.getState().completeSubagentRun(id, status);
  },
  onSubagentMessages: (id, messages) => {
    if (id) useAppStore.getState().setSubagentMessages(id, messages);
  },
}));
codeTools.register(suggestModeSwitchTool);

export const chatTools = new ToolRegistry({
  isToolEnabled: (name) => isToolAvailableInMode("chat", name),
});
chatTools.registerAll(createChatTools({
  getMemories: () => useBrainStore.getState().memories,
  addMemory: (text, kind) => useBrainStore.getState().addMemory(text, kind),
  getConversations: () => useAppStore.getState().conversations,
  getResearchRuns: () => useResearchStore.getState().runs,
  createResearchRun: (input) => useResearchStore.getState().createRun(input),
  updateResearchRun: (id, patch) => useResearchStore.getState().updateRun(id, patch),
  getResearchProvider: () => {
    const state = useAppStore.getState();
    const config = state.providers.find((item) => item.id === state.activeProviderId);
    if (!config) throw new Error("No active provider selected.");
    return {
      provider: createProvider(config),
      config,
      model: state.activeModel || config.defaultModel || "default",
    };
  },
  getSearchConfig: () => useResearchStore.getState().searchConfig,
}));
chatTools.registerAll(createBrowserTools());
chatTools.register(suggestModeSwitchTool);

export const flowTools = new ToolRegistry({
  isToolEnabled: (name) => isToolAvailableInMode("flow", name),
});
registerCodeToolset(flowTools, "flow");
flowTools.registerAll(createFlowTools({
  getProvider: () => {
    const state = useAppStore.getState();
    if (!state.activeProviderId) throw new Error("No active provider selected.");
    return new ProviderRegistry(state.providers).get(state.activeProviderId);
  },
  getModel: () => {
    const state = useAppStore.getState();
    if (!state.activeModel) throw new Error("No active model selected.");
    return state.activeModel;
  },
  getTools: () => codeTools,
  getProjectInstructions: () => {
    const state = useProjectStore.getState();
    return state.projects.find((p) => p.id === state.activeProjectId)?.instructions ?? "";
  },
}));
