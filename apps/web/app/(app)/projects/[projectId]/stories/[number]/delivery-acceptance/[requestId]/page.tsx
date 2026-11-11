import Link from "next/link";
import { ErrorNotice } from "@/components/offline";
import { DeliveryAcceptanceConfirmation } from "@/components/story/delivery-acceptance-confirmation";
import { api } from "@/lib/api";

export const metadata = { title: "Review delivery acceptance" };
export default async function DeliveryAcceptancePage({
  params,
}: {
  params: Promise<{ projectId: string; number: string; requestId: string }>;
}) {
  const { projectId, number: storyId, requestId } = await params;
  const review = await api.reviewDeliveryAcceptance(projectId, storyId, requestId);
  return (
    <div className="mx-auto flex min-w-0 max-w-4xl flex-col gap-5">
      <Link
        href={`/projects/${encodeURIComponent(projectId)}/stories/${encodeURIComponent(storyId)}`}
        className="text-sm underline"
      >
        ← current story
      </Link>
      {review.ok ? (
        <DeliveryAcceptanceConfirmation key={requestId} initial={review.data} />
      ) : (
        <ErrorNotice
          message={`Couldn't load this delivery review — ${review.message}. Open the story to inspect the current delivery or request a fresh review.`}
        />
      )}
    </div>
  );
}
