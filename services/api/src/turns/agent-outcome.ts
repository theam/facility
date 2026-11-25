const closingMarker = /<\/facility-(needs-attention|ready-for-review)>\s*$/;
const outcomeTag = /<\/?facility-(?:needs-attention|ready-for-review)>/;

export function agentOutcome(output: string): {
  output: string;
  attention?: string;
  readyForReview?: string;
} {
  const close = closingMarker.exec(output);
  if (!close) return { output };
  const tag = `<facility-${close[1]}>`;
  const start = output.lastIndexOf(tag, close.index);
  if (start < 0) return { output };
  const body = output.slice(0, start).trim();
  const detail = output.slice(start + tag.length, close.index).trim();
  // Don't interpret nested or consecutive control blocks as one valid outcome.
  if (!detail || outcomeTag.test(detail) || closingMarker.test(body)) return { output };
  if (close[1] === "needs-attention") return { output: body, attention: detail };
  if (!body) return { output: body };
  return { output: body, readyForReview: detail };
}
