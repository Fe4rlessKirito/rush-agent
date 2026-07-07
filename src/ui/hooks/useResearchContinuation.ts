import { useState } from "react";
import { createProvider } from "../../core/providers/registry";
import { runDeepResearch } from "../../core/researchRunner";
import type { ProviderConfig } from "../../core/providers/types";
import type { ResearchRun } from "../../core/researchStore";
import type { SearchConfig } from "../../core/searchProviders";

interface UseResearchContinuationOptions {
  selectedProvider: ProviderConfig | undefined;
  selectedModel: string;
  searchConfig: SearchConfig;
  updateRun: (id: string, patch: Partial<ResearchRun>) => void;
}

export function useResearchContinuation({
  selectedProvider,
  selectedModel,
  searchConfig,
  updateRun,
}: UseResearchContinuationOptions) {
  const [followUpText, setFollowUpText] = useState("");
  const [continuingRunId, setContinuingRunId] = useState<string | null>(null);

  async function continueResearchRun(run: ResearchRun | null | undefined) {
    const instruction = followUpText.trim();
    if (!run || continuingRunId || !instruction) return;
    if (!selectedProvider) {
      updateRun(run.id, { status: "error", error: "Pick a provider and model in Settings first." });
      return;
    }

    const id = run.id;
    setFollowUpText("");
    setContinuingRunId(id);
    updateRun(id, { status: "running", error: undefined, activity: "Continuing research..." });
    try {
      const provider = createProvider(selectedProvider);
      const result = await runDeepResearch({
        prompt: run.prompt,
        settings: run.settings,
        provider,
        providerConfig: selectedProvider,
        model: selectedModel,
        searchConfig,
        continuation: instruction,
        previousContent: run.content,
        previousSources: run.sources,
        callbacks: {
          onSources: (sources, warning) => updateRun(id, { sources, searchWarning: warning }),
          onContent: (content) => updateRun(id, { content }),
          onActivity: (activity) => updateRun(id, { activity }),
          onError: (error, content) => updateRun(id, { status: "error", content, error, activity: "Deep Research stopped with an error." }),
        },
      });
      updateRun(id, {
        status: "completed",
        activity: "Research report updated.",
        content: result.content,
        sources: result.sources,
        searchWarning: result.warning,
      });
    } catch (err) {
      updateRun(id, { status: "error", error: String(err), activity: "Deep Research stopped with an error." });
    } finally {
      setContinuingRunId(null);
    }
  }

  return {
    followUpText,
    setFollowUpText,
    continuingRunId,
    continueResearchRun,
  };
}
