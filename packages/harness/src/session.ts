import type { ArtifactChainConfig } from "./chain.js";

export type HarnessSessionInput = {
  chain: ArtifactChainConfig;
  charterMd: string;
  activeMd: string;
  apiBaseUrl: string;
  runId: string;
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
  const base = input.apiBaseUrl.replace(/\/$/, "");
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
`;
}
