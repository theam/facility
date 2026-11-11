import Link from "next/link";
import { ErrorNotice } from "@/components/offline";
import { PlanConfirmation } from "@/components/story/plan-confirmation";
import { api } from "@/lib/api";

export const metadata = { title: "Review plan decision" };

export default async function PlanDecisionPage({
  params,
}: {
  params: Promise<{ projectId: string; number: string; requestId: string }>;
}) {
  const { projectId, number: storyId, requestId } = await params;
  const review = await api.reviewStoryPlanDecision(projectId, storyId, requestId);
  return (
    <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-5">
      <Link
        className="text-[13px] text-(--mut) underline underline-offset-4"
        href={`/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}#story-plan`}
      >
        ← current story plan
      </Link>
      {review.ok ? (
        <PlanConfirmation key={requestId} initial={review.data} />
      ) : (
        <ErrorNotice
          message={`Couldn't load this plan review — ${review.message}. Open the story to inspect the current plan or request a fresh review.`}
        />
      )}
    </div>
  );
}
