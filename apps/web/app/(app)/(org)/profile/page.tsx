import { Divider, Eyebrow } from "@facility/ui";
import { Offline } from "@/components/offline";
import { AppearanceSetting } from "@/components/theme/appearance-setting";
import { api } from "@/lib/api";

export const metadata = { title: "profile" };

export default async function ProfilePage() {
  const me = await api.me();
  if (!me.ok) return <Offline detail={me.message} />;
  const { principal, preferences } = me.data;
  const identity = [
    ["Name", principal.name],
    ["Email", principal.email],
    ["GitHub", principal.githubLogin ? `@${principal.githubLogin}` : undefined],
  ].filter((row): row is [string, string] => !!row[1]);

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-2">
        <Eyebrow>your profile</Eyebrow>
        <h1 className="text-[clamp(24px,3.6vw,40px)] font-semibold leading-[1.08] tracking-[-0.02em]">
          {principal.name ?? principal.email ?? "Your profile"}
        </h1>
        <p className="text-sm leading-relaxed text-(--mut)">
          Settings that belong to you and follow you on every device.
        </p>
      </div>

      {identity.length ? (
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
          {identity.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-(--dim)">{label}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      <Divider />

      <section className="flex flex-col gap-4">
        <Eyebrow>appearance</Eyebrow>
        {preferences ? (
          <AppearanceSetting initial={preferences.theme} />
        ) : (
          <p className="text-sm text-(--mut)">
            Appearance settings are not available for this sign-in.
          </p>
        )}
      </section>
    </div>
  );
}
