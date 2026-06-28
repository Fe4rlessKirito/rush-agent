export const EFFORT_TIERS = ["Low", "Medium", "High", "Max"] as const;

export type EffortTier = (typeof EFFORT_TIERS)[number];
export type ThinkingLevel = "low" | "medium" | "high" | "max";

export function thinkingForEffort(index: number): ThinkingLevel {
  if (index <= 0) return "low";
  if (index === 1) return "medium";
  if (index === 2) return "high";
  return "max";
}
