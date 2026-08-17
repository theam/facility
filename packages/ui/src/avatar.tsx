import { cx } from "./cx";

/** `"` and `\` would end the CSS string early; whitespace would end the url() token. */
function cssUrl(src: string): string {
  return `url("${src.replace(/["\\\s]/g, encodeURIComponent)}")`;
}

/**
 * Square avatar with an initial-letter fallback underneath the image.
 *
 * The image is painted as a CSS background rather than as an `<img>` on
 * purpose. An `<img>` that fails to load makes every browser draw its own
 * broken-image glyph over the letter — `alt=""` does not suppress it — while a
 * background that fails to load paints nothing at all. So a deployment whose
 * browsers cannot reach the image host degrades to the letter on its own, with
 * nothing to configure.
 *
 * Decorative: the login it stands for is always written out beside it.
 */
export function Avatar({
  src,
  initial,
  size,
  className,
}: {
  src?: string;
  initial: string;
  size: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cx(
        "relative inline-flex flex-none items-center justify-center overflow-hidden",
        "rounded-[2px] border border-(--line) bg-(--card)",
        "font-mono font-semibold leading-none text-(--dim)",
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.5)),
      }}
    >
      {initial}
      {src ? (
        <span
          className="absolute inset-0 bg-cover bg-center bg-no-repeat"
          style={{ backgroundImage: cssUrl(src) }}
        />
      ) : null}
    </span>
  );
}
