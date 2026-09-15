/** Only Facility-owned login continuations, never arbitrary redirect destinations. */
export function safeReturnTo(value: string | undefined) {
  if (!value || value === "/" || value !== value.trim()) return "/";
  if (/^\/oauth\/interaction\/[A-Za-z0-9_-]+$/.test(value)) return value;
  return /^\/api\/workspace-preview-login\/ws_[a-z0-9]{16,64}\/[A-Za-z0-9_-]{1,64}\?challenge=[A-Za-z0-9_-]{43}$/.test(
    value,
  )
    ? value
    : "/";
}
