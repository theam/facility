import type { ArtifactChainConfig } from "./chain.js";

export type HarnessSessionInput = {
  chain: ArtifactChainConfig;
  charterMd: string;
  activeMd: string;
  runId: string;
  /** Agent mode of the run this bundle is for — gates mode-specific tool docs. */
  mode?: string;
};

export type HarnessBundleFragment = {
  files: Record<string, string>;
};

export function buildHarnessBundle(input: HarnessSessionInput): HarnessBundleFragment {
  return {
    files: {
      "harness/SESSION.md": sessionMd(input),
      "harness/CHARTER.md": input.charterMd,
      "harness/ACTIVE.md": input.activeMd,
      "harness/TOOLS.md": toolsMd(input),
    },
  };
}

function sessionMd(input: HarnessSessionInput) {
  const chainNames = Object.values(input.chain.types)
    .map((type) =>
      type.parentTypes.length > 0
        ? `${type.prefix} requires ${type.parentTypes.join("|")}`
        : `${type.prefix} is free`,
    )
    .join("\n- ");
  return `# Harness Session Protocol

Session recovery, every session and after any compaction:

1. Read CHARTER.
2. Read ACTIVE.
3. Open only the artifacts linked from ACTIVE.
4. Cross-check names, numbers, dates, and decisions between them.
5. Treat disagreement as a blocker.
6. Search the KB before creating anything.
7. Proceed only when the state is coherent.

ACTIVE is capped to four fields: Objective, Next Step, Blocker, Links. Overwrite it when the objective, next step, blocker, or relevant links change. Do not append a log to ACTIVE.

Conclusions must land in the KB before the session ends. A terminal successful result is blocked unless full-space validation passes.

## Chain Rules

- ${chainNames}
`;
}

function toolsMd(input: HarnessSessionInput) {
  const base = "$FACILITY_API_URL";
  return `# Platform Tool Notes

Authenticate with the run's platform key: send \`Authorization: Bearer $FACILITY_PLATFORM_KEY\`
(the runner exports it into the environment) against \`$FACILITY_API_URL\`. It is a
least-privilege, run-scoped key revoked when the run ends.

- Preflight KB write: POST ${base}/v1/projects/:projectId/kb/entries?dry=1
- Create KB entry: POST ${base}/v1/projects/:projectId/kb/entries
- Validate KB: POST ${base}/v1/projects/:projectId/kb/validate
- Stop gate: POST ${base}/v1/runs/${input.runId}/kb-checkpoint
- Propose task: POST ${base}/v1/tasks/:taskId/propose
- Submit proposal: POST ${base}/v1/proposals

Read the project before writing about it:

- Active decisions (not superseded): GET ${base}/v1/projects/:projectId/kb/decisions?active=1
- Search the KB (substring, optional &type=): GET ${base}/v1/projects/:projectId/kb/search?q=...
- An entry with its link neighborhood: GET ${base}/v1/kb/entries/:entryId/neighborhood
- Pipeline state (repository-qualified issue/PR stories by stage, current runs, CI, gates): GET ${base}/v1/projects/:projectId/pipeline

Proposal writers receive the allowed action-type IDs and required payload
fields in their run scope. A proposal is not submitted until POST /v1/proposals
returns 200; prose in the final response does not create an inbox item.
${productOwnerToolsMd(input)}`;
}

function productOwnerToolsMd(input: HarnessSessionInput) {
  if (input.mode !== "project-owner") return "";
  const base = "$FACILITY_API_URL";
  return `
## Product Owner Tools

You are the project's Product Owner: its decision record, its backlog, and its
interface to humans. Ground every answer in the KB and the pipeline — read
first, then write; never contradict an active decision without superseding it.

- Decisions are immutable. To change one, propose a superseding decision:
  submit a kb_amendment proposal whose payload includes \`supersedes\` set to
  the old decision's artifact id (e.g. "D2"). Approval retires the old one and
  records the chain.
- Idea -> issue: draft a task (POST ${base}/v1/projects/:projectId/tasks), then
  propose it (POST ${base}/v1/tasks/:taskId/propose). A human approves it in
  the inbox; approval creates the real GitHub issue. Never create issues
  directly.
- Backlog review from a transcript or note: the triggering log entry is in
  your run scope (kb_intake). Read it, read the pipeline, read active
  decisions, then emit each proposed change as its own proposal (new tasks via
  task drafts; decision changes via kb_amendment with supersedes; context
  updates by rewriting ACTIVE). Cite the log entry's artifact id as evidence
  in every proposal's contextMd.
- Consult the architect when a question needs the actual code: POST
  ${base}/v1/projects/:projectId/consult with {"question": "..."} dispatches a
  read-only architect run. Poll GET ${base}/v1/runs/:runId/result until status
  is terminal and read its answer. Prefer consulting over guessing about code.
`;
}
