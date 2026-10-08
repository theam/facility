import {
  type FacilityDb,
  githubBranches,
  githubCiEvents,
  githubPullRequests,
  storyEvidenceEvents,
  turnGitEvidence,
  turns,
} from "@facility/db";
import { and, asc, eq, gt, inArray, notInArray, or } from "drizzle-orm";

/**
 * Delivery-record checks: verify the promises 0.12 makes about its own
 * record, using only what the platform already writes. Read-only; observes
 * and never gates.
 *
 * - completeness: "Final SHA, commits, changed files, and dirty state are
 *   captured when it settles, including failure and cancellation paths."
 *   Every settled turn has either a completed capture or an explicit
 *   captureError; silent holes are findings.
 * - coherence: the record tells each turn twice at both ends. At the start,
 *   the turn_git_evidence row's initial fields and the turn:{id}:context
 *   event; at settlement, the row's final fields and the turn:{id}:git
 *   event — git.changes_recorded for a completed capture, git.capture_failed
 *   for an explicit failure. Insights and the story timeline read from this
 *   substrate, so the tellings must agree.
 * - attribution: "GitHub facts are linked to an exact Facility turn when
 *   their head SHA matches that turn's recorded final SHA." The mirror
 *   already uses that match at link time. Here it is read the other way:
 *   the head SHAs GitHub reported — over the signed webhook or the mirror
 *   scan, a channel the database does not write — are a witness. A turn
 *   whose final SHA GitHub has seen is witnessed; when the two internal
 *   tellings disagree about the final SHA, the witness says which side
 *   drifted. A turn GitHub has not seen is simply unwitnessed, not wrong.
 *
 * Every check enumerates from a ledger other than the one it verifies, so
 * a deleted row is visible from the ledger that still expects it.
 */

export type DeliveryRecordCheck = "completeness" | "coherence" | "attribution";

export type DeliveryRecordFinding = {
  check: DeliveryRecordCheck;
  turnId: string;
  storyId: string;
  shape:
    | "missing-evidence"
    | "unsettled-capture"
    | "missing-context"
    | "missing-event"
    | "divergent"
    | "witness-disagrees";
  detail: string;
};

export type DeliveryRecordReport = {
  checkedTurns: number;
  /**
   * Settled turns whose capture never began: the dispatcher failed or was
   * canceled before `TurnGitEvidenceService.start()` ran (budget rejection,
   * credential issue, environment preparation, cancel while queued), so
   * neither telling exists. Counted so coverage stays honest; not a finding.
   */
  unstartedCaptures: number;
  /** Completed captures whose final SHA GitHub has independently reported. */
  witnessedTurns: number;
  findings: DeliveryRecordFinding[];
  /** Keyset cursor (last inspected turn id) when a page was full, else null. */
  cursor: string | null;
};

const ACTIVE_TURN_STATES = ["queued", "running"];

export type WitnessObservation = { sha: string; branch: string };

/**
 * What GitHub has reported about the given SHAs, as (sha, branch) pairs:
 * branch heads by name, pull heads and CI heads by the pull's head ref.
 * Distinct server-side, so the rows returned are bounded by the distinct
 * pairs the mirror holds for the page's SHAs, never by how many times
 * GitHub reported them (a busy pull produces hundreds of CI observations
 * for one head).
 */
export async function witnessObservations(
  db: FacilityDb,
  scope: { orgId: string; projectId: string },
  shas: string[],
): Promise<WitnessObservation[]> {
  if (shas.length === 0) return [];
  const [branchRows, pullRows, ciRows] = await Promise.all([
    db
      .selectDistinct({ sha: githubBranches.headSha, branch: githubBranches.name })
      .from(githubBranches)
      .where(
        and(
          eq(githubBranches.orgId, scope.orgId),
          eq(githubBranches.projectId, scope.projectId),
          inArray(githubBranches.headSha, shas),
        ),
      ),
    db
      .selectDistinct({
        sha: githubPullRequests.headSha,
        ciSha: githubPullRequests.ciHeadSha,
        branch: githubPullRequests.headRef,
      })
      .from(githubPullRequests)
      .where(
        and(
          eq(githubPullRequests.orgId, scope.orgId),
          eq(githubPullRequests.projectId, scope.projectId),
          or(
            inArray(githubPullRequests.headSha, shas),
            inArray(githubPullRequests.ciHeadSha, shas),
          ),
        ),
      ),
    db
      .selectDistinct({ sha: githubCiEvents.headSha, branch: githubPullRequests.headRef })
      .from(githubCiEvents)
      .innerJoin(
        githubPullRequests,
        and(
          eq(githubPullRequests.repositoryId, githubCiEvents.repositoryId),
          eq(githubPullRequests.number, githubCiEvents.pullNumber),
        ),
      )
      .where(
        and(
          eq(githubCiEvents.orgId, scope.orgId),
          eq(githubCiEvents.projectId, scope.projectId),
          inArray(githubCiEvents.headSha, shas),
        ),
      ),
  ]);
  const asked = new Set(shas);
  const observations: WitnessObservation[] = [...branchRows, ...ciRows];
  for (const row of pullRows) {
    if (asked.has(row.sha)) observations.push({ sha: row.sha, branch: row.branch });
    if (row.ciSha && asked.has(row.ciSha))
      observations.push({ sha: row.ciSha, branch: row.branch });
  }
  return observations;
}

type Telling = {
  finalSha: string | null;
  commits: unknown;
};

/**
 * Whether GitHub corroborates one telling of a turn's final state. Presence
 * of the SHA somewhere in GitHub's record is not enough — an old head is
 * still a real SHA — so three things must hold: GitHub reported the SHA on
 * the turn's own branch; the SHA is not the turn's starting point (unless
 * the telling records no commits, an honest no-op); and the telling's own
 * commit list ends at that SHA (the writer logs `--reverse` from the initial
 * SHA to HEAD). A telling that fails any of these is uncorroborated, which
 * is not the same as wrong.
 */
function corroborated(
  telling: Telling,
  turn: { branch: string | null; initialSha: string },
  witnessed: Map<string, Set<string>>,
): boolean {
  const sha = telling.finalSha;
  if (!sha) return false;
  const branches = witnessed.get(sha);
  if (!branches || !turn.branch || !branches.has(turn.branch)) return false;
  const commits = Array.isArray(telling.commits)
    ? (telling.commits as Record<string, unknown>[])
    : [];
  if (commits.length === 0) return sha === turn.initialSha;
  if (sha === turn.initialSha) return false;
  return commits.at(-1)?.sha === sha;
}

export async function verifyDeliveryRecord(
  db: FacilityDb,
  input: { orgId: string; projectId: string; limit?: number; cursor?: string },
): Promise<DeliveryRecordReport> {
  const limit = Math.min(Math.max(input.limit ?? 200, 1), 1_000);
  const settled = await db
    .select({ id: turns.id, storyId: turns.storyId, state: turns.state })
    .from(turns)
    .where(
      and(
        eq(turns.orgId, input.orgId),
        eq(turns.projectId, input.projectId),
        notInArray(turns.state, ACTIVE_TURN_STATES),
        ...(input.cursor ? [gt(turns.id, input.cursor)] : []),
      ),
    )
    .orderBy(asc(turns.id))
    .limit(limit);

  if (settled.length === 0) {
    return { checkedTurns: 0, unstartedCaptures: 0, witnessedTurns: 0, findings: [], cursor: null };
  }

  const turnIds = settled.map((turn) => turn.id);
  const eventKeys = turnIds.flatMap((id) => [`turn:${id}:git`, `turn:${id}:context`]);
  const [evidenceRows, events] = await Promise.all([
    db
      .select()
      .from(turnGitEvidence)
      .where(and(eq(turnGitEvidence.orgId, input.orgId), inArray(turnGitEvidence.turnId, turnIds))),
    db
      .select()
      .from(storyEvidenceEvents)
      .where(
        and(
          eq(storyEvidenceEvents.orgId, input.orgId),
          inArray(storyEvidenceEvents.externalKey, eventKeys),
        ),
      ),
  ]);
  const rowByTurn = new Map(evidenceRows.map((row) => [row.turnId, row]));
  const gitEventByTurn = new Map<string, (typeof events)[number]>();
  const contextEventByTurn = new Map<string, (typeof events)[number]>();
  for (const event of events) {
    const match = /^turn:(.+):(git|context)$/.exec(event.externalKey ?? "");
    if (!match?.[1]) continue;
    (match[2] === "git" ? gitEventByTurn : contextEventByTurn).set(match[1], event);
  }
  // Ask GitHub's record only about the SHAs this page actually mentions.
  const candidateShas = new Set<string>();
  for (const row of evidenceRows) if (row.finalSha) candidateShas.add(row.finalSha);
  for (const event of gitEventByTurn.values()) {
    const finalSha = (event.data as Record<string, unknown> | null)?.finalSha;
    if (typeof finalSha === "string") candidateShas.add(finalSha);
  }
  const witnessed = new Map<string, Set<string>>();
  for (const seen of await witnessObservations(db, input, [...candidateShas])) {
    const branches = witnessed.get(seen.sha) ?? new Set<string>();
    branches.add(seen.branch);
    witnessed.set(seen.sha, branches);
  }

  const findings: DeliveryRecordFinding[] = [];
  let witnessedTurns = 0;
  let unstartedCaptures = 0;
  for (const turn of settled) {
    const row = rowByTurn.get(turn.id);
    const context = contextEventByTurn.get(turn.id);
    if (!row) {
      // TurnGitEvidenceService.start() writes the row and then the context
      // event, and the dispatcher only reaches it after the budget check,
      // credential issue and environment preparation. A turn that failed or
      // was canceled with neither telling never began capture; that is the
      // lifecycle, not a hole. A succeeded turn cannot have skipped start(),
      // and a context event without its row means the row was destroyed.
      if (!context && turn.state !== "succeeded") {
        unstartedCaptures += 1;
        continue;
      }
      findings.push({
        check: "completeness",
        turnId: turn.id,
        storyId: turn.storyId,
        shape: "missing-evidence",
        detail: `turn settled as ${turn.state} with no git evidence row`,
      });
      continue;
    }

    // The start of the turn is told twice: the row's initial fields and the
    // turn:{id}:context event written before the engine ran.
    if (!context) {
      findings.push({
        check: "coherence",
        turnId: turn.id,
        storyId: turn.storyId,
        shape: "missing-context",
        detail: "evidence row has no matching turn context event",
      });
    } else {
      const contextData = (context.data ?? {}) as Record<string, unknown>;
      const contextDivergences: string[] = [];
      if (contextData.initialSha !== row.initialSha) contextDivergences.push("initialSha");
      if ((contextData.branch ?? null) !== (row.initialBranch ?? null)) {
        contextDivergences.push("initialBranch");
      }
      if (contextData.workspaceId !== row.workspaceId) contextDivergences.push("workspaceId");
      if (contextData.sessionId !== row.engineSessionId) contextDivergences.push("engineSessionId");
      if (contextDivergences.length > 0) {
        findings.push({
          check: "coherence",
          turnId: turn.id,
          storyId: turn.storyId,
          shape: "divergent",
          detail: `row and context event disagree on ${contextDivergences.join(", ")}`,
        });
      }
    }

    const captured = row.completedAt != null && row.finalSha != null;
    if (!captured && row.captureError == null) {
      findings.push({
        check: "completeness",
        turnId: turn.id,
        storyId: turn.storyId,
        shape: "unsettled-capture",
        detail: `turn settled as ${turn.state} but capture neither completed nor recorded an error`,
      });
      continue;
    }
    const event = gitEventByTurn.get(turn.id);
    if (!captured) {
      // The captureError path satisfies completeness: the failure is explicit —
      // and it writes its own event, which must be the one on record.
      if (!event) {
        findings.push({
          check: "coherence",
          turnId: turn.id,
          storyId: turn.storyId,
          shape: "missing-event",
          detail: "capture error recorded but no git.capture_failed event",
        });
      } else if (event.type !== "git.capture_failed") {
        findings.push({
          check: "coherence",
          turnId: turn.id,
          storyId: turn.storyId,
          shape: "divergent",
          detail: `row records a capture error but the event on record is ${event.type}`,
        });
      }
      continue;
    }

    // The branch the turn worked on, told by the context event when it
    // exists (a telling the row did not write), else by the row itself.
    const contextBranch = (context?.data as Record<string, unknown> | null)?.branch;
    const turnScope = {
      branch:
        typeof contextBranch === "string" ? contextBranch : (row.finalBranch ?? row.initialBranch),
      initialSha: row.initialSha,
    };
    const rowWitnessed = corroborated(row, turnScope, witnessed);
    if (rowWitnessed) witnessedTurns += 1;

    if (!event) {
      findings.push({
        check: "coherence",
        turnId: turn.id,
        storyId: turn.storyId,
        shape: "missing-event",
        detail: "completed capture has no matching story evidence event",
      });
      continue;
    }
    if (event.type !== "git.changes_recorded") {
      findings.push({
        check: "coherence",
        turnId: turn.id,
        storyId: turn.storyId,
        shape: "divergent",
        detail: `row records a completed capture but the event on record is ${event.type}`,
      });
      continue;
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    const divergences: string[] = [];
    if (data.initialSha !== row.initialSha) divergences.push("initialSha");
    if (data.finalSha !== row.finalSha) divergences.push("finalSha");
    const rowCommits = Array.isArray(row.commits) ? (row.commits as Record<string, unknown>[]) : [];
    const eventCommits = Array.isArray(data.commits)
      ? (data.commits as Record<string, unknown>[])
      : [];
    if (eventCommits.length !== rowCommits.length) {
      divergences.push("commits.length");
    } else {
      for (let index = 0; index < rowCommits.length; index++) {
        if (rowCommits[index]?.sha !== eventCommits[index]?.sha) {
          divergences.push(`commits[${index}].sha`);
          break;
        }
      }
    }
    if (Boolean(data.dirty) !== Boolean(row.dirty)) divergences.push("dirty");
    if (divergences.length === 0) continue;

    // When the two tellings disagree about the final SHA, ask the witness —
    // and only convict when it corroborates exactly one side on this turn's
    // own terms. Presence of a SHA alone is not a verdict.
    const eventWitnessed = corroborated(
      { finalSha: typeof data.finalSha === "string" ? data.finalSha : null, commits: data.commits },
      turnScope,
      witnessed,
    );
    if (divergences.includes("finalSha") && rowWitnessed !== eventWitnessed) {
      const seen = rowWitnessed ? "evidence row" : "evidence event";
      const drifted = rowWitnessed ? "evidence event" : "evidence row";
      findings.push({
        check: "attribution",
        turnId: turn.id,
        storyId: turn.storyId,
        shape: "witness-disagrees",
        detail: `GitHub reported the ${seen}'s final SHA; the ${drifted} drifted (disagree on ${divergences.join(", ")})`,
      });
      continue;
    }
    findings.push({
      check: "coherence",
      turnId: turn.id,
      storyId: turn.storyId,
      shape: "divergent",
      detail: `row and event disagree on ${divergences.join(", ")}`,
    });
  }

  return {
    checkedTurns: settled.length,
    unstartedCaptures,
    witnessedTurns,
    findings,
    cursor: settled.length === limit ? (settled.at(-1)?.id ?? null) : null,
  };
}
