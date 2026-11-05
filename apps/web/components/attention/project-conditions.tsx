import type { ProjectAttentionStories } from "@facility/sdk";
import Link from "next/link";
import { money } from "@/lib/overview-presentation";

export function ProjectConditions({
  data,
  base,
}: {
  data: Pick<ProjectAttentionStories, "budget" | "workflowPolicy">;
  base: string;
}) {
  const budget = data.budget;
  if (!budget || !data.workflowPolicy)
    return (
      <p className="text-xs text-(--mut)">
        Project limits are unavailable in this response. Open the project overview to check them.
      </p>
    );
  const blocked =
    budget.available && (budget.state === "exceeded" || budget.state === "unconfirmed");
  const warning = budget.available && budget.state === "warning";
  const policyBlocked = !data.workflowPolicy.available;
  if (!blocked && !warning && !policyBlocked)
    return !budget.available ? (
      <p className="text-xs text-(--mut)">Budget state is not visible with your permissions.</p>
    ) : null;
  return (
    <section
      aria-label={blocked || policyBlocked ? "Project blockers" : "Budget warning"}
      className="flex flex-col gap-3 border border-(--line-strong) bg-(--bg-subtle) p-5"
    >
      <h2 className="font-semibold">
        {blocked || policyBlocked ? "Now · project limits" : "For the next review · budget"}
      </h2>
      {budget.available && (blocked || warning) ? (
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">
            {budget.state === "unconfirmed"
              ? "Spending needs reconciliation"
              : budget.state === "exceeded"
                ? "The project budget is exhausted"
                : "The budget warning threshold has been reached"}
          </h3>
          <p className="text-(--mut)">
            {budget.state === "unconfirmed"
              ? "New model calls are held while spending is unconfirmed."
              : budget.state === "exceeded"
                ? "No budget remains for new paid model calls. This does not stop work already running."
                : "This threshold is a warning; it does not by itself stop new work."}
          </p>
          <p>
            {budget.state === "unconfirmed" ? "Recorded commitments: " : ""}
            {money(budget.spentCents)} committed
            {budget.monthlyLimitCents !== null ? ` of ${money(budget.monthlyLimitCents)}` : ""}.
            {budget.state === "unconfirmed" ? " Total spending is unconfirmed." : ""}
          </p>
          <Link
            href={`${base}/insights`}
            className="inline-flex min-h-11 w-fit items-center text-(--info) underline underline-offset-4"
          >
            Review budget and spending
          </Link>
        </div>
      ) : null}
      {policyBlocked ? (
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">Workflow policy needs repair</h3>
          <p className="text-(--mut)">{data.workflowPolicy.error}</p>
          <Link
            href={`${base}/settings`}
            className="inline-flex min-h-11 w-fit items-center text-(--info) underline underline-offset-4"
          >
            Open project settings
          </Link>
        </div>
      ) : null}
    </section>
  );
}
