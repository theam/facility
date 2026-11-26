import { sql } from "drizzle-orm";
import { RESULT_REVIEW_ATTENTION } from "./phase.js";

/** Resolve a saved result independently of the conversation page currently visible.
 * Keep the outer table qualified: Drizzle strips interpolated column qualifiers in
 * single-table selects, which would otherwise bind these names to story_messages. */
export const resultMessageId = sql<string | null>`
  case when attention_items.kind = ${RESULT_REVIEW_ATTENTION} then (
    select m.id
    from story_messages m
    where m.org_id = attention_items.org_id
      and m.project_id = attention_items.project_id
      and m.story_id = attention_items.story_id
      and m.turn_id = attention_items.turn_id
      and m.role = 'agent'
    order by m.seq desc
    limit 1
  ) end
`;
