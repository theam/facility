export const MAIN_CONTENT_ID = "main-content";

export function SkipLink() {
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:border focus:border-(--line-strong) focus:bg-(--bg) focus:px-4 focus:py-3 focus:text-[13px] focus:text-(--ink)"
    >
      Skip to main content
    </a>
  );
}
