"use client";

import type { StoryPlan } from "@facility/sdk";
import { useId, useState } from "react";

type Brief = Extract<NonNullable<StoryPlan["decisionBrief"]>, { status: "available" }>["brief"];
type Claim = Brief["summary"];
type Format = "summary" | "comparison" | "diagram";

/** Formats explain the same saved statements; none of these controls makes a decision. */
export function DecisionBrief({
  brief,
  revision,
  delivery,
}: { brief: Brief } & (
  | { revision: number; delivery?: never }
  | { revision?: never; delivery: { scopeRevision: number; candidateRevision: string } }
)) {
  const subject = delivery ? `delivery scope r${delivery.scopeRevision}` : `plan r${revision}`;
  const [format, setFormat] = useState<Format>("summary");
  const group = useId();
  const recommended = brief.options.find((option) => option.id === brief.recommendation?.optionId);
  function claim(value: Claim) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <p className="break-words">{value.text}</p>
        {value.evidenceIds.length ? (
          <ul
            className="flex flex-wrap gap-x-3 gap-y-1 text-xs font-normal text-(--mut)"
            aria-label="Sources for this statement"
          >
            {value.evidenceIds.map((id) => {
              const source = brief.evidence.find((item) => item.id === id);
              return source ? (
                <li key={id} className="min-w-0 break-words">
                  <a
                    href={source.url}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-(--line-strong) underline-offset-4 hover:text-(--ink)"
                    title={source.reference}
                  >
                    {source.label} ↗
                  </a>
                </li>
              ) : null;
            })}
          </ul>
        ) : null}
      </div>
    );
  }
  function optionLabel(option: Brief["options"][number], index: number) {
    return (
      <>
        <span>
          {index + 1}. {option.label}
        </span>
        {option.id === recommended?.id ? (
          <span className="mt-1 block text-xs font-normal text-(--mut)">Recommended</span>
        ) : null}
      </>
    );
  }
  return (
    <section
      aria-label={`Author’s decision brief for ${subject}`}
      className="flex min-w-0 flex-col gap-4 text-[15px] leading-relaxed"
    >
      <div className="text-[17px] font-medium leading-snug">{claim(brief.summary)}</div>
      <div className="text-(--mut)">{claim(brief.whyNow)}</div>
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {recommended ? `Author recommends: ${recommended.label}` : "No recommendation supplied"}
        </p>
        {brief.recommendation ? claim(brief.recommendation.reason) : null}
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
      <details className="min-w-0 text-sm">
        <summary className="min-h-11 w-fit cursor-pointer py-3 text-(--info)">
          Options and sources
        </summary>
        <div className="flex min-w-0 flex-col gap-4 pt-2">
          <fieldset className="min-w-0 sm:col-span-2">
            <legend className="sr-only">Option format</legend>
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ["summary", "Summary"],
                  ["comparison", "Comparison"],
                  ["diagram", "Diagram"],
                ] as const
              ).map(([value, label]) => (
                <label
                  key={value}
                  className={`flex min-h-11 cursor-pointer items-center border-b-2 px-3 py-2 has-focus-visible:outline-2 has-focus-visible:outline-(--info) ${format === value ? "border-(--info) text-(--ink)" : "border-transparent text-(--mut)"}`}
                >
                  <input
                    type="radio"
                    name={group}
                    value={value}
                    checked={format === value}
                    onChange={() => setFormat(value)}
                    className="sr-only"
                  />
                  {label}
                </label>
              ))}
            </div>
          </fieldset>
          <div aria-live="polite" aria-atomic="true" className="sr-only">
            Options shown as {format}. The recommendation and sources are unchanged.
          </div>
          {format === "comparison" ? (
            <section
              className="min-w-0 overflow-x-auto sm:col-span-2"
              aria-label="Option comparison"
            >
              <table className="w-full table-fixed border-collapse text-left text-sm">
                <caption className="sr-only">
                  Options and consequences from the same{" "}
                  {delivery ? "delivery candidate" : "plan revision"}
                </caption>
                <thead>
                  <tr>
                    <th scope="col" className="w-2/5 border-b border-(--line) p-2 align-top">
                      Option
                    </th>
                    <th scope="col" className="border-b border-(--line) p-2">
                      Consequence
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {brief.options.map((option, index) => (
                    <tr key={option.id}>
                      <th
                        scope="row"
                        className="break-words border-b border-(--line) p-2 align-top font-medium"
                      >
                        {optionLabel(option, index)}
                      </th>
                      <td className="break-words border-b border-(--line) p-2 align-top">
                        {claim(option.consequence)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <div className="min-w-0 sm:col-span-2">
              <ol
                className="grid min-w-0 gap-4 sm:grid-cols-2"
                aria-label="Options and consequences"
              >
                {brief.options.map((option, index) => (
                  <li
                    key={option.id}
                    className={`min-w-0 ${format === "diagram" ? "border border-(--line) bg-(--card) p-4" : ""}`}
                  >
                    <p className="break-words font-medium">{optionLabel(option, index)}</p>
                    {format === "diagram" ? (
                      <span aria-hidden="true" className="my-2 block text-(--mut)">
                        ↓
                      </span>
                    ) : null}
                    <div className={format === "summary" ? "mt-2 text-(--mut)" : "text-(--mut)"}>
                      {claim(option.consequence)}
                    </div>
                  </li>
                ))}
              </ol>
            </div>
          )}
          {brief.evidence.length ? (
            <details className="text-xs text-(--mut) sm:col-span-2">
              <summary className="cursor-pointer py-2">
                Source references · {brief.evidence.length}
              </summary>
              <ul className="mt-2 flex flex-col gap-3">
                {brief.evidence.map((source) => (
                  <li key={source.id} className="break-words">
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline underline-offset-4"
                    >
                      {source.label}
                    </a>
                    <p className="mt-1">{source.reference}</p>
                  </li>
                ))}
              </ul>
            </details>
          ) : (
            <p className="text-xs text-(--mut) sm:col-span-2">
              No source links were supplied in this brief.
            </p>
          )}
          <p className="text-xs text-(--mut)">
            {delivery ? `Supplied for ${subject}` : `Supplied in ${subject}`}. Author statements.
          </p>
        </div>
      </details>
    </section>
  );
}
