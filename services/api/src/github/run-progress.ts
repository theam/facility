export type GithubRunProgressPhase =
  | "queued"
  | "provisioning"
  | "running"
  | "succeeded"
  | "failed"
  | "canceled";

export type GithubRunProgressInput = {
  runId: string;
  mode: string;
  command?: string | null;
  phase: GithubRunProgressPhase;
  issueNumber: number;
  issueTitle?: string | null;
  sender?: string | null;
  agentProgress?: string | null;
  finalText?: string | null;
  error?: string | null;
  proposalId?: string | null;
  pullRequest?: { number: number; url: string } | null;
};

const COMMENT_LIMIT = 65_000;
const RESULT_LIMIT = 48_000;

export function renderGithubRunProgress(input: GithubRunProgressInput) {
  const terminal = ["succeeded", "failed", "canceled"].includes(input.phase);
  const succeeded = input.phase === "succeeded";
  const command = input.command || `/${input.mode}`;
  const title = singleLine(input.issueTitle);
  const status = progressStatus(input.phase);
  const icon = terminal ? (succeeded ? "✅" : input.phase === "canceled" ? "⏹️" : "❌") : "⏳";
  const accepted = true;
  const sandboxReady = ["running", "succeeded", "failed", "canceled"].includes(input.phase);
  const agentFinished = terminal;
  const published = succeeded;
  const finalLabel = isArchitect(input.mode)
    ? "Published the plan and opened Human Gate 1"
    : "Published the governed delivery result";

  const lines = [
    `<!-- facility-run-progress run=${input.runId} -->`,
    `### ${icon} Facility \`${command}\``,
    "",
    `**Status:** ${status}`,
    `**Current phase:** ${progressPhase(input.phase, input.mode)}`,
    `**Run:** \`${input.runId}\``,
    `**Request:** #${input.issueNumber}${title ? ` — ${title}` : ""}${input.sender ? ` (requested by @${input.sender})` : ""}`,
    "",
    "## Progress",
    checklist(accepted, `Accepted ${command} request`),
    checklist(sandboxReady, "Prepared the repository sandbox and run-scoped credentials"),
    checklist(agentFinished, `Ran the ${input.mode} agent and configured acceptance checks`),
    checklist(published, finalLabel),
  ];

  if (input.agentProgress?.trim()) {
    lines.push("", "## Agent progress", "", truncate(input.agentProgress.trim(), 12_000));
  } else if (!terminal) {
    lines.push(
      "",
      "## Agent progress",
      "",
      "_Waiting for the agent to publish its task-specific checklist._",
    );
  }

  if (terminal) {
    lines.push("", "## Result", "");
    if (!succeeded && input.error?.trim()) {
      lines.push(
        `**Failure boundary:** \`${singleLine(input.error) ?? "run_failed"}\``,
        "",
        "The last assistant message may describe work completed before the interruption; it is not the failure reason. Resume this run from its latest Facility checkpoint after correcting any policy or provider issue.",
      );
    } else if (input.finalText?.trim()) {
      lines.push(truncate(input.finalText.trim(), RESULT_LIMIT));
    } else if (succeeded) {
      lines.push("_The run completed without a captured final message._");
    } else {
      lines.push(
        `_The run ${input.phase}. Inspect the Facility session events for the failure boundary and retry guidance._`,
      );
    }
    if (input.proposalId) {
      lines.push(
        "",
        "## Continue from GitHub",
        "",
        `- Approve this plan and start implementation by commenting \`/${builderCommand(input.command, input.mode)}\`.`,
        `- Request another planning pass by commenting \`/${architectCommand(input.command, input.mode)} <feedback>\`.`,
        `- Proposal audit ID: \`${input.proposalId}\`. The architect cannot approve its own proposal.`,
      );
    }
    if (input.pullRequest) {
      lines.push(
        "",
        `**Human Gate 2:** [review pull request #${input.pullRequest.number}](${input.pullRequest.url}). Facility never merges it automatically.`,
      );
    }
  } else {
    lines.push(
      "",
      "_This comment is updated as the run crosses execution milestones and is replaced with the final result._",
    );
  }

  lines.push("", `_Last updated: ${new Date().toISOString()}_`);
  return truncate(lines.join("\n"), COMMENT_LIMIT);
}

export function renderBuilderPlanDenial(code: string) {
  const guidance: Record<string, string> = {
    builder_plan_required:
      "Run `/architect` first, review the published plan, then approve it with `/builder`.",
    builder_plan_context_invalid:
      "The linked Architect approval is not canonical. Run `/architect` again to create a new governed plan.",
    builder_plan_expired:
      "The Architect approval expired. Run `/architect` again to create a fresh plan.",
    builder_plan_rejected:
      "The Architect plan was rejected. Run `/architect` again after updating the request.",
    builder_plan_already_consumed:
      "That Architect approval has already been consumed. Inspect its Builder run or create a new plan with `/architect`.",
    builder_plan_stale:
      "The repository base or issue scope changed after planning. Run `/architect` again against the current state.",
    builder_plan_freshness_unavailable:
      "Facility could not verify the approved base and live issue revision. No Builder run was started; run `/architect` again after provenance support is available.",
  };
  return [
    "<!-- facility-run-progress gate=builder-plan -->",
    "### 🛑 Facility `/builder` blocked",
    "",
    "No Builder run was created because Human Gate 1 did not have valid plan evidence.",
    "",
    guidance[code] ?? guidance.builder_plan_context_invalid,
    "",
    `**Policy reason:** \`${code}\``,
  ].join("\n");
}

export function progressCommentId(gh: unknown) {
  const root = objectOrEmpty(gh);
  const progress = objectOrEmpty(root.progressComment);
  return typeof progress.id === "number" && Number.isInteger(progress.id) ? progress.id : null;
}

function progressStatus(phase: GithubRunProgressPhase) {
  if (phase === "succeeded") return "Completed";
  if (phase === "failed") return "Failed";
  if (phase === "canceled") return "Canceled";
  return "In progress";
}

function progressPhase(phase: GithubRunProgressPhase, mode: string) {
  if (phase === "queued") return "Accepted; waiting for sandbox capacity";
  if (phase === "provisioning") return "Preparing the repository sandbox";
  if (phase === "running") return `${mode} agent is working`;
  if (phase === "succeeded") return "Final result published";
  if (phase === "failed") return "Stopped at a failed execution boundary";
  return "Canceled by an operator";
}

function checklist(done: boolean, label: string) {
  return `- [${done ? "x" : " "}] ${label}`;
}

function isArchitect(mode: string) {
  return mode === "architect" || mode.endsWith("-architect");
}

function builderCommand(command: string | null | undefined, mode: string) {
  return (command ?? `/${mode}`).includes("codex-") ? "codex-builder" : "builder";
}

function architectCommand(command: string | null | undefined, mode: string) {
  return (command ?? `/${mode}`).includes("codex-") ? "codex-architect" : "architect";
}

function singleLine(value: unknown) {
  return typeof value === "string" && value.trim()
    ? truncate(
        value
          .replace(/[\r\n]+/g, " ")
          .trim()
          .replace(/[\\`*_{}[\]<>()#+.!|-]/g, "\\$&"),
        240,
      )
    : null;
}

function truncate(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
