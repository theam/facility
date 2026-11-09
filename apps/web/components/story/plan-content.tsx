import type { StoryPlan } from "@facility/sdk";
import { Markdown } from "@/components/markdown";
import { formatTime } from "@/lib/story-presentation";

export function PlanContent({ plan }: { plan: StoryPlan }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <p className="text-[12px] text-(--mut)">
        Revision {plan.revision} · proposed by{" "}
        {plan.proposedBy.name ??
          (plan.proposedBy.type === "service" ? "a service" : "a project member")}{" "}
        · {formatTime(plan.proposedAt)}
      </p>
      <div className="min-w-0 break-words text-[14px] leading-relaxed [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto">
        <Markdown source={plan.markdown} />
      </div>
      <dl className="grid min-w-0 gap-4 border-t border-(--line) pt-4 text-[12px] sm:grid-cols-2">
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
          <dt className="mb-1 text-(--dim)">Agents in this plan</dt>
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
      {plan.source ? (
        <p className="text-[12px] text-(--dim)">
          Proposed from the exact {plan.source.role} message text in this story.
        </p>
      ) : null}
      <details className="min-w-0 text-[11px] text-(--dim)">
        <summary className="cursor-pointer">Revision evidence</summary>
        <dl className="mt-2 flex flex-col gap-2 break-all">
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
        </dl>
      </details>
    </div>
  );
}
