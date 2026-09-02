import { Divider, Eyebrow } from "@facility/ui";
import { ErrorNotice, Offline } from "@/components/offline";
import { KeysManager } from "@/components/settings/keys-manager";
import { MembersList } from "@/components/settings/members-list";
import { api, type Member, type MemberRow } from "@/lib/api";

export const metadata = { title: "settings" };

function flattenMembers(rows: MemberRow[]): Member[] {
  return rows.map((row) => ({
    userId: row.member.userId,
    email: row.user.email,
    name: row.user.name,
    roleId: row.member.roleId,
    roleName: row.role.name,
  }));
}

function hasPermission(grants: string[], permission: string) {
  const [resource] = permission.split(":");
  return grants.some((grant) => grant === "*" || grant === permission || grant === `${resource}:*`);
}

export default async function SettingsPage() {
  const [me, keys, roles, members] = await Promise.all([
    api.me(),
    api.keys(),
    api.roles(),
    api.members(),
  ]);
  if (!me.ok) return <Offline detail={me.message} />;

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <div className="flex flex-col gap-2">
        <Eyebrow>settings</Eyebrow>
        <h1 className="text-[clamp(24px,3.6vw,40px)] font-semibold leading-[1.08] tracking-[-0.02em]">
          {me.data.org?.name ?? "Facility"}
        </h1>
        <p className="text-sm leading-relaxed text-(--mut)">
          Human sessions and MCP clients use the same project access. Agents always receive full
          workspace and GitHub maintainer capability for connected repositories.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <Eyebrow>members</Eyebrow>
        {members.ok && roles.ok ? (
          <MembersList
            members={flattenMembers(members.data)}
            roles={roles.data}
            canManage={hasPermission(me.data.permissions, "members:write")}
          />
        ) : (
          <ErrorNotice message="Members or roles could not be loaded." />
        )}
      </section>

      <Divider />

      <section className="flex flex-col gap-4">
        <Eyebrow>MCP access</Eyebrow>
        <p className="text-sm leading-relaxed text-(--mut)">
          API keys authenticate non-interactive MCP clients. OAuth clients can connect with the
          signed-in maintainer identity instead.
        </p>
        {keys.ok && roles.ok ? (
          <KeysManager keys={keys.data} roles={roles.data} />
        ) : (
          <ErrorNotice message="API keys or roles could not be loaded." />
        )}
      </section>
    </div>
  );
}
