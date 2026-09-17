/** A deliberate wake after failure grants the operator control of the environment. */
export function shouldSuspendFailedWorkspace(input: {
  workspaceState: string;
  workspaceUpdatedAt: Date;
  latestTurnState?: string;
  latestTurnEndedAt?: Date | null;
  hasPendingWork: boolean;
}): boolean {
  return (
    ["running", "error"].includes(input.workspaceState) &&
    input.latestTurnState === "failed" &&
    !!input.latestTurnEndedAt &&
    input.workspaceUpdatedAt <= input.latestTurnEndedAt &&
    !input.hasPendingWork
  );
}
