import type { ChatLine, Conversation, SubagentRun } from "../../core/store";
import type { ResearchRun } from "../../core/researchStore";
import type { ProviderConfig } from "../../core/providers/types";
import { groupRenderedChat } from "./chatPanelHelpers";
import {
  filterLibraryConversations,
  filterLibraryResearchRuns,
} from "./libraryContext";

const MAX_RENDERED_MESSAGES = 80;

interface ChatPanelViewStateOptions {
  conversations: Conversation[];
  activeConversationId: string;
  contextQuery: string;
  researchRuns: ResearchRun[];
  providers: ProviderConfig[];
  activeProviderId: string | null;
  isAgentMode: boolean;
  subagentRuns: SubagentRun[];
  activeSubagentRunId: string | null;
  chat: ChatLine[];
  showAllMessages: boolean;
}

export function useChatPanelViewState({
  conversations,
  activeConversationId,
  contextQuery,
  researchRuns,
  providers,
  activeProviderId,
  isAgentMode,
  subagentRuns,
  activeSubagentRunId,
  chat,
  showAllMessages,
}: ChatPanelViewStateOptions) {
  const pickerConversations = filterLibraryConversations(conversations, activeConversationId, contextQuery);
  const pickerResearchRuns = filterLibraryResearchRuns(researchRuns, contextQuery);
  const activeProviderConfig = providers.find((p) => p.id === activeProviderId);
  const attachmentAccept = isAgentMode || activeProviderConfig?.supportsFileChatEndpoint
    ? undefined
    : "image/*";
  const conversationSubagents = subagentRuns
    .filter((run) => run.parentConversationId === activeConversationId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const activeSubagent = activeSubagentRunId
    ? conversationSubagents.find((run) => run.id === activeSubagentRunId) ?? null
    : null;
  const visibleLines = activeSubagent ? activeSubagent.lines : chat;
  const renderedChatStart = showAllMessages ? 0 : Math.max(0, visibleLines.length - MAX_RENDERED_MESSAGES);
  const renderedChat = visibleLines.slice(renderedChatStart);
  const renderedItems = groupRenderedChat(renderedChat, renderedChatStart);
  const hiddenMessageCount = renderedChatStart;

  return {
    pickerConversations,
    pickerResearchRuns,
    attachmentAccept,
    conversationSubagents,
    activeSubagent,
    visibleLines,
    renderedChatStart,
    renderedChat,
    renderedItems,
    hiddenMessageCount,
  };
}
