interface SubagentReadonlyComposerProps {
  status: string;
}

export function SubagentReadonlyComposer({ status }: SubagentReadonlyComposerProps) {
  return (
    <div className="composer subagent-readonly-composer">
      <span className={"subagent-status " + status} aria-hidden="true" />
      <span>Viewing subagent chat - only the coordinator can continue this thread.</span>
    </div>
  );
}
