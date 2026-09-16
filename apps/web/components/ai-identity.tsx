import { cx } from "@facility/ui";
import Image from "next/image";
import type { AiBrand, AiIdentity as Identity } from "@/lib/ai-identity";

const BRAND_ASSETS: Record<AiBrand, { src: string; owner: string }> = {
  claude: { src: "/brands/claude.svg", owner: "Anthropic" },
  openai: { src: "/brands/openai.svg", owner: "OpenAI" },
};

export function AiIdentity({ identity, className }: { identity: Identity; className?: string }) {
  return (
    <span
      className={cx("inline-flex min-w-0 items-center gap-1.5", className)}
      translate={identity.brand ? "no" : undefined}
    >
      {identity.brand ? <AiMark brand={identity.brand} /> : null}
      <span className="min-w-0 truncate">{identity.label}</span>
    </span>
  );
}

/** A standalone mark, without the label or spacing of a full identity. */
export function AiMark({ brand, className }: { brand: AiBrand; className?: string }) {
  const asset = BRAND_ASSETS[brand];
  return (
    <span
      className={cx(
        "inline-flex size-4 shrink-0 items-center justify-center overflow-hidden",
        className,
      )}
      aria-hidden="true"
    >
      <Image
        src={asset.src}
        width={16}
        height={16}
        unoptimized
        alt=""
        title={`${asset.owner} mark`}
        // The OpenAI artwork fills the central half of its official SVG canvas.
        // Remove that built-in whitespace at display time, preserving the source asset.
        className={cx("size-full object-contain", brand === "openai" && "scale-200")}
      />
    </span>
  );
}
