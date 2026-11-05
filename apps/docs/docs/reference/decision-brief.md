---
title: Author decision briefs
---

# Author decision briefs

Include a short decision brief in a plan when a person needs to choose an approach. The complete
plan remains the original. Facility offers summary, comparison and diagram views of the same saved
statements, with direct source links and one toggle to the original text. Format changes are local
reads; they do not call a model, start compute or submit a decision.

This is an optional author output contract, independent of agent names. Architect, Builder,
Reviewer, QA and custom agents can use it. A recommendation is not approval, verified evidence,
urgency, an assignee or permission to change the scope. Existing workflow policy and the exact
plan decision continue to govern execution. Reviewing a different option does not authorize a
different plan; propose a new revision when its scope changes.

## Instruction for an author

Add this guidance to the Markdown body of the relevant project agent through its normal reviewed
configuration flow. Do not add frontmatter fields. Existing project manifests are not updated by
installing a newer Facility release; queued turns retain their captured instructions.

> Investigate uncertainty that you can resolve within the authorized task. Record routine work
> without manufacturing a human decision. If the next step changes objective, risk, cost or
> commitment, explain what the person must decide. Include one `facility-decision` JSON block
> following the schema below, followed by the complete plan and verification detail. Give two
> to four real options with consequences, your recommendation or explicit lack of one, the risk
> that could change the choice, and missing evidence. Link decisive claims to inspected sources
> with exact commits, heads, receipts or observation references where available. Attribute
> unverified claims and unknowns. Do not invent sources, successful checks, policy or authority.
> Do not treat the brief itself as a request to execute or a replacement for required approval.

The instruction complements the agent's role. It does not create a reviewer correction loop,
change its round or budget limits, or grant an orchestrator authority.

## Format and limits

Use one top-level fenced code block with the language `facility-decision`. Backtick and tilde
fences are accepted; quoted examples and blocks nested in another fence are not interpreted as
the document's brief. Keep the JSON block within 16,000 characters and the whole plan within its
existing 100,000-character limit. Unknown fields and versions are invalid.

| Field | Contract |
| --- | --- |
| `schemaVersion` | `1`. |
| `summary`, `whyNow`, `decisiveRisk` | A claim: `text` (1–600 characters) and `evidenceIds` (0–8 unique source IDs). `whyNow` is the author's reason, not a system urgency classification. |
| `options` | 2–4 objects with unique `id`, `label` (1–100 characters) and `consequence` (a claim). Order supplies the numbers shown in every view. |
| `recommendation` | An object with a listed `optionId` and `reason` (a claim), or `null` when no recommendation is available. |
| `unknowns` | 0–5 claims. An empty list means the author listed none; it does not prove evidence is complete. |
| `evidence` | 0–8 sources with unique `id`, `label` (1–120 characters), `reference` (1–160 characters) and `url` (at most 2,000 characters). |

IDs match `[a-z][a-z0-9_-]{0,31}`. Every referenced source must exist. Use an empty `evidenceIds`
array for a clearly attributed judgment or unknown without a linked source. A source URL must be
absolute HTTP(S), without credentials, control characters or backslashes. References are supplied
by the author and are not downloaded or verified when Facility reads the plan. The UI renders
claim text as text, not HTML or executable diagrams.

Example with synthetic evidence:

```facility-decision
{
  "schemaVersion": 1,
  "summary": { "text": "Choose whether to resume the retained task.", "evidenceIds": ["scope"] },
  "whyNow": { "text": "The new plan includes the missing repository.", "evidenceIds": ["scope"] },
  "options": [
    { "id": "resume", "label": "Review and approve this plan", "consequence": { "text": "Matching queued work may resume after current execution checks.", "evidenceIds": ["scope"] } },
    { "id": "revise", "label": "Request a smaller scope", "consequence": { "text": "The author must propose a new revision.", "evidenceIds": [] } }
  ],
  "recommendation": { "optionId": "resume", "reason": { "text": "The task still matches the requested objective.", "evidenceIds": ["scope"] } },
  "decisiveRisk": { "text": "Preparation with the additional repository remains untested.", "evidenceIds": [] },
  "unknowns": [{ "text": "Successful preparation and measured execution cost remain unobserved.", "evidenceIds": [] }],
  "evidence": [{ "id": "scope", "label": "Scope review", "reference": "Synthetic review recorded 2026-11-05", "url": "https://example.com/reviews/scope-r3" }]
}
```

## Revision, provenance and compatibility

`StoryPlan.decisionBrief` is an additive read projection. `status: available` includes `brief`;
`absent` means no matching block was found; `invalid` includes one of `duplicate`, `malformed`,
`unsupported_version`, `invalid_fields` or `too_large`. Missing or invalid briefs leave the full
original visible. They do not reject a legacy plan or weaken confirmation checks. Older servers
without this projection keep the existing full-plan presentation.

The brief lives in the original Markdown, so the existing immutable revision and digest bind it
to the exact plan. Changing it requires a new plan revision. No migration or separate inference
cache is required. Current-plan reads, exact-revision reads, interactive confirmation, SDK and
`facility_get_plan` share this projection; metadata-only history does not repeat it.

`proposedBy` identifies who registered the plan, not necessarily its author. A `source` reference
means the proposed text exactly matched a scoped story message when recorded. Its original text,
message and turn IDs remain available with the plan. Selected execution agents do not identify
the author. Old revisions retain their own briefs and are presented as history.

Plan reads require `projects:read`; proposing and preparing decisions require `projects:write`.
Interactive confirmation retains its own membership, proof, expiry, revision and idempotency
checks. A source being linked does not grant access to its destination or certify its freshness.

Continue with [operating a story](../guides/operate-story.md) or the
[MCP plan workflow](mcp.md#propose-and-review-a-plan).
