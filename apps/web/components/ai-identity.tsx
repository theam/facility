import { cx } from "@facility/ui";
import Image from "next/image";
import type { AiBrand, AiIdentity as Identity } from "@/lib/ai-identity";

const BRAND_ASSETS: Record<AiBrand, { src: string; owner: string }> = {
  claude: { src: "/brands/claude.svg", owner: "Anthropic" },
  openai: { src: "/brands/openai.svg", owner: "OpenAI" },
};

export function AiIdentity({
  identity,
  className,
  iconClassName,
}: {
  identity: Identity;
  className?: string;
  iconClassName?: string;
}) {
  const asset = identity.brand ? BRAND_ASSETS[identity.brand] : null;
  return (
    <span
      className={cx("inline-flex min-w-0 items-center gap-1.5", className)}
      translate={asset ? "no" : undefined}
    >
      {asset ? (
        <Image
          src={asset.src}
          width={16}
          height={16}
          unoptimized
          alt=""
          aria-hidden="true"
          title={`${asset.owner} mark`}
          className={cx("size-4 shrink-0 object-contain", iconClassName)}
        />
      ) : null}
      <span className="min-w-0 truncate">{identity.label}</span>
    </span>
  );
}
