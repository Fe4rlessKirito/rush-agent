import { useEffect, useState } from "react";

export function useActiveRunTimer(busy: boolean) {
  const [activeRunStartedAt, setActiveRunStartedAt] = useState<number | null>(null);
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());

  useEffect(() => {
    if (!busy) {
      setActiveRunStartedAt(null);
      return;
    }
    setActiveRunStartedAt((startedAt) => startedAt ?? Date.now());
    setElapsedNow(Date.now());
    const timer = window.setInterval(() => setElapsedNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [busy]);

  return { activeRunStartedAt, elapsedNow };
}
