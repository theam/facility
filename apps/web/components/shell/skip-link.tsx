/**
 * First focusable element of both authenticated shells: bypasses the sidebar
 * and topbar for keyboard users (WCAG 2.4.1). Visually hidden until focused,
 * then fixed top-left so it stays visible over every shell variant.
 */
export function SkipLink() {
  return (
    <a
      href="#main-content"
      className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 rounded-[4px] border border-(--line-strong) bg-(--card) px-4 py-2 text-sm font-medium text-(--ink)"
    >
      Skip to main content
    </a>
  );
}
