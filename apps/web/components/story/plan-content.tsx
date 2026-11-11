import type { StoryPlan } from "@facility/sdk";
import Link from "next/link";
import type { ReactNode } from "react";
import { Markdown } from "@/components/markdown";
import { DecisionBrief } from "@/components/story/decision-brief";
import { ExpandableMarkdown } from "@/components/story/expandable-markdown";
import { formatTime } from "@/lib/story-presentation";
import { storyReviewHref } from "@/lib/story-review-navigation";

/**
 * The decision reads top to bottom: the author's brief, what Facility checked,
 * the actions, and one disclosure for the original plan, scope and evidence.
 */
export function PlanContent({
  plan,
  originalOnly = false,
  location,
  checks,
  actions,
}: {
  plan: StoryPlan;
  originalOnly?: boolean;
  checks?: ReactNode;
  actions?: ReactNode;
  location?: { projectId: string; storyId: string };
}) {
  const brief =
    !originalOnly && plan.decisionBrief?.status === "available" ? plan.decisionBrief.brief : null;
  const original = (
    <div className="min-w-0 break-words text-[14px] leading-relaxed [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
      <Markdown source={plan.markdown} />
    </div>
  );
  const scope = (
    <div className="flex min-w-0 flex-col gap-5 pt-2 text-[12px]">
      <dl className="grid min-w-0 gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <dt className="mb-1 text-(--dim)">Repositories in this plan</dt>
          <dd>
            <ul>
              {plan.repositories.map((repo) => (
                <li key={repo.repositoryId} className="break-words">
                  {repo.repository}
                </li>
              ))}
            </ul>
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="mb-1 text-(--dim)">Agents selected for execution</dt>
          <dd>
            <ul>
              {plan.agents.map((agent) => (
                <li key={agent.name} className="break-words">
                  {agent.name}{" "}
                  <span className="text-(--mut)">
                    · {agent.engine === "codex" ? "Codex" : "Claude Code"} · {agent.model}
                  </span>
                </li>
              ))}
            </ul>
          </dd>
        </div>
      </dl>
      {plan.source && location ? (
        <Link
          className="inline-flex min-h-11 w-fit items-center text-(--info) underline underline-offset-4"
          href={storyReviewHref(
            location.projectId,
            location.storyId,
            { revision: plan.revision, digest: plan.digest },
            plan.source.messageId,
            `message-${plan.source.messageId}`,
          )}
        >
          Open original message and author
        </Link>
      ) : null}
      <dl className="flex flex-col gap-2 break-all text-[11px] text-(--dim)">
        <div>
          <dt>Plan digest</dt>
          <dd className="font-mono">{plan.digest}</dd>
        </div>
        {plan.agents.map((agent) => (
          <div key={agent.name}>
            <dt>
              {agent.name} configuration observed {formatTime(agent.observedAt)}
            </dt>
            <dd className="font-mono">
              {agent.catalogCommitSha} · {agent.manifestHash}
            </dd>
          </div>
        ))}
        {plan.source ? (
          <div>
            <dt>Exact source message ({plan.source.role})</dt>
            <dd className="font-mono">
              {plan.source.messageId}
              {plan.source.turnId ? ` · turn ${plan.source.turnId}` : ""}
            </dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
  const summary = `${plan.repositories.length} ${plan.repositories.length === 1 ? "repository" : "repositories"} · ${plan.agents.map((agent) => agent.name).join(", ")}`;
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <p className="text-[12px] text-(--mut)">
        Revision {plan.revision} · proposed by{" "}
        {plan.proposedBy.name ??
          (plan.proposedBy.type === "service" ? "a service" : "a project member")}{" "}
        · {formatTime(plan.proposedAt)}
      </p>
      {brief ? (
        <>
          <DecisionBrief key={plan.digest} brief={brief} revision={plan.revision} />
          {checks}
          {actions}
          <details className="min-w-0 border-t border-(--line) pt-1 text-sm">
            <summary className="min-h-11 cursor-pointer py-3 text-(--mut)">
              Original plan r{plan.revision} · {summary}
            </summary>
            <div className="mt-2 flex min-w-0 flex-col gap-6">
              {original}
              {scope}
            </div>
          </details>
        </>
      ) : (
        <>
          {!originalOnly ? (
            <p className="text-xs text-(--mut)">
              {plan.decisionBrief?.status === "invalid"
                ? "The structured brief could not be read. Review the complete original plan below."
                : "No structured brief was supplied. Review the complete plan below."}
            </p>
          ) : null}
          <div className="min-w-0 break-words text-[14px] leading-relaxed [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
            <ExpandableMarkdown source={plan.markdown} label={`plan r${plan.revision}`} />
          </div>
          {checks}
          {actions}
          <details className="min-w-0 border-t border-(--line) pt-1 text-sm">
            <summary className="min-h-11 cursor-pointer py-3 text-(--mut)">
              Scope and evidence · {summary}
            </summary>
            {scope}
          </details>
        </>
      )}
    </div>
  );
}
