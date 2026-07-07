"use client";

import { Button, Select, TextInput } from "@facility/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Member, Role } from "@/lib/api";

/**
 * The org roster with its verbs: invite, change role, remove — every write is
 * role-assignability-checked server-side (you can't hand out more than you hold).
 */
export function MembersList({
  members,
  roles,
  canManage,
}: {
  members: Member[];
  roles: Role[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState(roles[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function call(path: string, init: RequestInit, key: string) {
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(`/api${path}`, {
        headers: { "content-type": "application/json" },
        ...init,
      });
      const payload = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!res.ok) throw new Error(payload?.error?.message ?? `${res.status}`);
      router.refresh();
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "request failed");
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim() || !roleId) return;
    const ok = await call(
      "/v1/members",
      { method: "POST", body: JSON.stringify({ email: email.trim(), roleId }) },
      "invite",
    );
    if (ok) setEmail("");
  }

  return (
    <div className="flex flex-col gap-4">
      {members.length === 0 ? (
        <p className="text-sm text-(--dim)">No members yet.</p>
      ) : (
        <div className="flex flex-col border border-(--line)">
          {members.map((m) => (
            <div
              key={m.userId}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-(--line) px-4 py-3 last:border-b-0"
            >
              <span className="font-mono text-[13px] text-(--ink)">{m.email}</span>
              {m.name ? <span className="text-[12px] text-(--mut)">{m.name}</span> : null}
              <div className="ml-auto flex items-center gap-2">
                {canManage ? (
                  <>
                    <Select
                      value={m.roleId}
                      aria-label={`Role for ${m.email}`}
                      disabled={busy !== null}
                      onChange={(e) =>
                        void call(
                          `/v1/members/${m.userId}`,
                          { method: "PATCH", body: JSON.stringify({ roleId: e.target.value }) },
                          `role:${m.userId}`,
                        )
                      }
                    >
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </Select>
                    <Button
                      size="sm"
                      variant={armedRemove === m.userId ? "danger" : "outline"}
                      disabled={busy !== null}
                      onClick={() => {
                        if (armedRemove !== m.userId) {
                          setArmedRemove(m.userId);
                          return;
                        }
                        setArmedRemove(null);
                        void call(
                          `/v1/members/${m.userId}`,
                          { method: "DELETE" },
                          `rm:${m.userId}`,
                        );
                      }}
                    >
                      {armedRemove === m.userId ? "confirm remove" : "remove"}
                    </Button>
                  </>
                ) : (
                  <span className="text-[11.5px] font-medium text-(--dim)">
                    {m.roleName ?? m.roleId}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {canManage ? (
        <form onSubmit={invite} className="flex flex-wrap items-center gap-3">
          <TextInput
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            aria-label="Invite email"
            className="w-64"
          />
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} aria-label="Role">
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            disabled={busy !== null || !email.trim()}
          >
            {busy === "invite" ? "inviting…" : "invite"}
          </Button>
        </form>
      ) : null}
      {error ? <p className="font-mono text-[11px] text-(--bad)">{error}</p> : null}
    </div>
  );
}
