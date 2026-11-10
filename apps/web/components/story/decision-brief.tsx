import type { StoryPlan } from "@facility/sdk";

type Brief = Extract<NonNullable<StoryPlan["decisionBrief"]>, { status: "available" }>["brief"];
type Claim = Brief["summary"];

/**
 * The saved brief as one block read top to bottom: what is decided and why now,
 * the options with their consequences, the recommendation and its reason, the
 * risk and what is still unknown. Each statement carries numbered links to its
 * sources, listed once at the end. Nothing here makes a decision.
 */
export function DecisionBrief({
  brief,
  revision,
  delivery,
}: { brief: Brief } & (
  | { revision: number; delivery?: never }
  | { revision?: never; delivery: { scopeRevision: number; candidateRevision: string } }
)) {
  const subject = delivery ? `delivery scope r${delivery.scopeRevision}` : `plan r${revision}`;
  const sources = new Map(brief.evidence.map((source) => [source.id, source]));
  const order: string[] = [];
  function number(id: string) {
    if (!order.includes(id)) order.push(id);
    return order.indexOf(id) + 1;
  }
  function claim(value: Claim, className = "", prefix?: string) {
    return (
      <p className={`break-words ${className}`}>
        {prefix ? <span className="text-(--mut)">{prefix} </span> : null}
        {value.text}
        {value.evidenceIds.map((id) => {
          const source = sources.get(id);
          if (!source) return null;
          const index = number(id);
          return (
            <a
              key={id}
              href={source.url}
              target="_blank"
              rel="noreferrer"
              title={`${source.label} · ${source.reference}`}
              aria-label={`Source ${index}: ${source.label}`}
              className="ml-1 align-super text-[11px] font-normal text-(--info) hover:underline"
            >
              [{index}]
            </a>
          );
        })}
      </p>
    );
  }
  const recommended = brief.recommendation?.optionId;
  return (
    <section
      aria-label={`Author’s decision brief for ${subject}`}
      className="flex min-w-0 flex-col gap-5 text-[15px] leading-relaxed"
    >
      <div className="flex flex-col gap-1">
        {claim(brief.summary, "text-[17px] font-medium leading-snug")}
        {claim(brief.whyNow, "text-(--mut)")}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className="text-[12px] font-medium text-(--mut)">Options</h4>
        <ol className="flex flex-col gap-3" aria-label="Options and consequences">
          {brief.options.map((option, index) => (
            <li key={option.id} className="flex min-w-0 gap-3">
              <span
                aria-hidden="true"
                className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border border-(--line) text-[12px] text-(--mut)"
              >
                {index + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className="break-words font-medium">
                  {option.label}
                  {option.id === recommended ? (
                    <span className="ml-2 inline-block rounded-[4px] bg-(--info)/15 px-1.5 align-middle text-[11px] font-medium text-(--info)">
                      Recommended
                    </span>
                  ) : null}
                </p>
                {claim(option.consequence, "text-sm text-(--mut)")}
                {option.id === recommended && brief.recommendation
                  ? claim(brief.recommendation.reason, "mt-1 text-sm", "Why:")
                  : null}
              </div>
            </li>
          ))}
        </ol>
        {brief.recommendation ? null : (
          <p className="text-sm text-(--mut)">No recommendation supplied.</p>
        )}
      </div>
      <div className="flex gap-2">
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="mt-1 size-4 shrink-0 text-(--human)"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M8 1.75 15 14.25H1L8 1.75Z" strokeLinejoin="round" />
          <path d="M8 6v3.5M8 11.5v.5" strokeLinecap="round" />
        </svg>
        <div className="min-w-0">
          <h4 className="sr-only">Risk</h4>
          {claim(brief.decisiveRisk)}
        </div>
      </div>
      {brief.unknowns.length ? (
        <div className="flex flex-col gap-1 text-sm text-(--mut)">
          <h4>Still unknown</h4>
          <ul className="flex flex-col gap-1">
            {brief.unknowns.map((value, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: immutable statements in a single revision
              <li key={index}>{claim(value)}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {(() => {
        for (const source of brief.evidence) number(source.id);
        return order.length ? (
          <div className="text-xs text-(--mut)">
            <h4 className="mb-1 font-medium">Sources</h4>
            <ol className="flex flex-col gap-1" aria-label="Sources">
              {order.map((id, index) => {
                const source = sources.get(id);
                return source ? (
                  <li key={id} className="break-words">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-(--info) hover:underline"
                    >
                      [{index + 1}] {source.label} ↗
                    </a>{" "}
                    <span className="text-(--dim)">{source.reference}</span>
                  </li>
                ) : null;
              })}
            </ol>
          </div>
        ) : (
          <p className="text-xs text-(--mut)">No source links were supplied in this brief.</p>
        );
      })()}
      <p className="text-xs text-(--dim)">
        {delivery ? `Supplied for ${subject}` : `Supplied in ${subject}`}. These are the author’s
        statements, not checks made by Facility.
      </p>
    </section>
  );
}
