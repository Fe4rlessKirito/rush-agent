import { useEffect, useState } from "react";
import { createProvider } from "../../core/providers/registry";
import { filterProviderModels } from "../../core/providers/modelGroups";
import type { ProviderConfig } from "../../core/providers/types";

interface ProviderModelsOptions {
  providers: ProviderConfig[];
  activeProviderId: string | null;
  activeModel: string | null;
  setActive: (providerId: string, model: string) => void;
}

export function useProviderModels({
  providers,
  activeProviderId,
  activeModel,
  setActive,
}: ProviderModelsOptions): string[] {
  const [models, setModels] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const cfg = providers.find((p) => p.id === activeProviderId);
    if (!cfg) {
      setModels([]);
      return;
    }
    createProvider(cfg)
      .listModels()
      .then((m) => {
        if (cancelled) return;
        const filtered = filterProviderModels(cfg.id, m);
        setModels(filtered);
        if (filtered.length > 0 && activeModel && !filtered.includes(activeModel)) {
          setActive(cfg.id, filtered[0]);
        }
      })
      .catch(() => !cancelled && setModels([]));
    return () => {
      cancelled = true;
    };
  }, [activeModel, activeProviderId, providers, setActive]);

  return models;
}
