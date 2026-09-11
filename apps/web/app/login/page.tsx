import { ButtonLink } from "@facility/ui";

export default function LoginPage() {
  const localDevelopment = process.env.NODE_ENV !== "production";
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-10 px-6">
      <div className="flex flex-col gap-3">
        <span className="font-mono text-[22px] font-semibold tracking-tight">
          facility<span className="text-(--accent)">.</span>
        </span>
        <p className="text-sm leading-relaxed text-(--mut)">
          One persistent workspace and shared agent conversation for every story.
        </p>
      </div>

      <div className="flex flex-col gap-6">
        <ButtonLink
          href={localDevelopment ? "/api/auth/dev-login" : "/api/auth/login"}
          variant="primary"
          size="lg"
        >
          {localDevelopment ? "continue locally" : "continue with GitHub"}
        </ButtonLink>
      </div>

      <p className="font-mono text-[10px] leading-relaxed text-(--dim)">
        An initiative by{" "}
        <a href="https://theagilemonkeys.com" className="underline-offset-4 hover:underline">
          The Agile Monkeys
        </a>
      </p>
    </div>
  );
}
