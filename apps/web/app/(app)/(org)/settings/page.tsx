import { Divider, Eyebrow } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { BudgetsManager } from "@/components/settings/budgets-manager";
import { IntegrationsManager } from "@/components/settings/integrations-manager";
import { KeysManager } from "@/components/settings/keys-manager";
import { MembersList } from "@/components/settings/members-list";
import { ProvidersManager } from "@/components/settings/providers-manager";
import { api, type Member, type MemberRow } from "@/lib/api";

export const metadata = { title: "settings" };

function flattenMembers(rows: MemberRow[]): Member[] {
  return rows.map((r) => ({
    userId: r.member.userId,
    email: r.user.email,
    name: r.user.name,
    roleId: r.member.roleId,
    roleName: r.role.name,
  }));
}

export default async function SettingsPage() {
  const [me, keys, roles, budgets, membersRaw, providers, integrations, projects] =
    await Promise.all([
      api.me(),
      api.keys(),
      api.roles(),
      api.budgets(),
      api.members(),
      api.providers(),
      api.integrations(),
      api.projects(),
    ]);
  if (!me.ok) return <Offline detail={me.message} />;

  // Match the backend's wildcard-aware `can()`: a grant of `resource:*` (e.g. the
  // bundled admin's `providers:*`) covers the specific action, so the UI gate must
  // accept it too — otherwise a section is hidden from someone who can use it.
  const canManageKeys = me.data.permissions.some(
    (p) => p === "*" || p === "keys:issue" || p === "keys:*",
  );
  const canManageBudgets = me.data.permissions.some(
    (p) => p === "*" || p === "budgets:write" || p === "budgets:*",
  );
  const canManageProviders = me.data.permissions.some(
    (p) => p === "*" || p === "providers:write" || p === "providers:*",
  );
  const canManageMembers = me.data.permissions.some(
    (p) => p === "*" || p === "members:write" || p === "members:*",
  );
  const canManageIntegrations = me.data.permissions.some(
    (p) => p === "*" || p === "integrations:write" || p === "integrations:*",
  );

  return (
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-2">
        <Eyebrow>settings</Eyebrow>
        <h1 className="text-[clamp(24px,3.6vw,40px)] font-semibold leading-[1.08] tracking-[-0.02em]">
          {me.data.org?.name ?? "Facility"}
        </h1>
      </div>

      <section className="flex max-w-2xl flex-col gap-4">
        <Eyebrow>your access</Eyebrow>
        <div className="flex flex-col gap-3 border border-(--line) p-6">
          <div className="flex items-center justify-between">
            <span className="text-sm text-(--mut)">signed in as</span>
            <span className="font-mono text-[13px] text-(--ink)">{me.data.principal.email}</span>
          </div>
          <div className="flex items-start justify-between gap-6">
            <span className="text-sm text-(--mut)">permissions</span>
            <div className="flex max-w-md flex-wrap justify-end gap-x-3 gap-y-1">
              {me.data.permissions.map((p) => (
                <span key={p} className="font-mono text-[10.5px] text-(--dim)">
                  {p}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      <Divider />

      <section className="flex max-w-2xl flex-col gap-4">
        <Eyebrow>members</Eyebrow>
        {membersRaw.ok ? (
          <MembersList
            members={flattenMembers(membersRaw.data)}
            roles={roles.ok ? roles.data : []}
            canManage={canManageMembers && roles.ok}
          />
        ) : (
          <p className="text-sm text-(--dim)">Members are visible to admins.</p>
        )}
      </section>

      {canManageKeys ? (
        <section className="flex max-w-2xl flex-col gap-4">
          <Eyebrow>api keys</Eyebrow>
          <p className="text-sm leading-relaxed text-(--mut)">
            Machine access for the CLI, MCP, and integrations. Each key carries a role — RBAC is
            identical to a human session.
          </p>
          {keys.ok ? (
            <>
              {!roles.ok ? (
                <ErrorNotice
                  message={`Couldn't load roles — issuing a key is disabled until they load (${roles.message})`}
                />
              ) : null}
              <KeysManager keys={keys.data} roles={roles.ok ? roles.data : []} />
            </>
          ) : (
            <ErrorNotice message={`Couldn't load API keys — ${keys.message}`} />
          )}
        </section>
      ) : null}

      {canManageProviders ? (
        <section className="flex max-w-2xl flex-col gap-4">
          <Eyebrow>providers</Eyebrow>
          <p className="text-sm leading-relaxed text-(--mut)">
            API keys or Claude subscription credentials the gateway proxies every call through.
            Sealed at rest; the secret is never shown again after you add it.
          </p>
          {providers.ok ? (
            <ProvidersManager providers={providers.data} />
          ) : (
            <ErrorNotice message={`Couldn't load providers — ${providers.message}`} />
          )}
        </section>
      ) : null}

      {canManageIntegrations ? (
        <section className="flex max-w-3xl flex-col gap-4">
          <Eyebrow>integrations — event sources</Eyebrow>
          <p className="text-sm leading-relaxed text-(--mut)">
            Where events come from: feedback tools, transcript feeds, custom sources. Configured
            once with a sealed secret; an event can raise an alert or dispatch an agent session.
          </p>
          {integrations.ok ? (
            <IntegrationsManager
              integrations={integrations.data}
              projects={projects.ok ? projects.data.map((p) => ({ id: p.id, slug: p.slug })) : []}
            />
          ) : (
            <ErrorNotice message={`Couldn't load integrations — ${integrations.message}`} />
          )}
        </section>
      ) : null}

      {canManageBudgets ? (
        <section className="flex max-w-2xl flex-col gap-4">
          <Eyebrow>budgets</Eyebrow>
          <p className="text-sm leading-relaxed text-(--mut)">
            Enforced at the gateway on every model call. Soft warns; hard stops.
          </p>
          {budgets.ok ? (
            <BudgetsManager budgets={budgets.data} />
          ) : (
            <ErrorNotice
              message={`Couldn't load budgets — enforcement status unknown; don't assume spend is uncapped (${budgets.message})`}
            />
          )}
        </section>
      ) : null}
    </div>
  );
}
