import { randomUUID } from "node:crypto";
import type { FacilityDb } from "@facility/db";
import {
  githubInstallations,
  storyIntegrationNotifications as notifications,
  projectRepositories,
  stories,
} from "@facility/db";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { GithubClientFactory } from "../github/client.js";
import { githubRateLimitRetryAt } from "../github/rate-limit.js";
import type { PreviewSite } from "../workspaces/preview-sites.js";
import type { ProjectBacklogService } from "./backlog.js";
import { contentRevision, readStoryLifecycle } from "./lifecycle.js";

type Scope = { orgId: string; projectId: string; storyId: string };
type Pending = typeof notifications.$inferSelect.pending;
const LEASE_MS = 120_000;

export function lifecycleChanges(
  snapshot: Awaited<ReturnType<typeof readStoryLifecycle>>,
  repositoryId: string,
  previous: { storyRevision: string | null; workspaceRevision: string | null },
  now: Date,
) {
  const { workspace, observedAt: _time, revision: _revision, ...story } = snapshot;
  const storyRevision = contentRevision({ repositoryId, story });
  const workspaceRevision = contentRevision({ repositoryId, workspace });
  const pending: Pending = [];
  if (previous.storyRevision !== storyRevision)
    pending.push({
      eventId: randomUUID(),
      type: "story.updated",
      occurredAt: now.toISOString(),
      workspaceId: workspace?.id ?? null,
    });
  if (previous.workspaceRevision !== workspaceRevision)
    pending.push({
      eventId: randomUUID(),
      type: "workspace.updated",
      occurredAt: now.toISOString(),
      workspaceId: workspace?.id ?? null,
    });
  return { storyRevision, workspaceRevision, pending };
}

/**
 * Reconcile coarse notifications, not project scripts. A durable cursor covers
 * config-only site changes and crash recovery without coupling lifecycle writes
 * to GitHub availability. Rapid intermediate transitions may be coalesced.
 */
export class StoryIntegrationNotifications {
  constructor(
    private readonly db: FacilityDb,
    private readonly backlog: ProjectBacklogService,
    private readonly sites: PreviewSite[],
    private readonly github: GithubClientFactory,
  ) {}

  async tick(now = new Date(), limit = 100) {
    const due = await this.db
      .select({ orgId: stories.orgId, projectId: stories.projectId, storyId: stories.id })
      .from(stories)
      .leftJoin(notifications, eq(notifications.storyId, stories.id))
      .where(
        and(
          or(isNull(notifications.nextAttemptAt), lte(notifications.nextAttemptAt, now)),
          or(isNull(notifications.leaseUntil), lte(notifications.leaseUntil, now)),
        ),
      )
      .orderBy(
        asc(sql`coalesce(${notifications.observedAt}, '1970-01-01'::timestamptz)`),
        asc(stories.id),
      )
      .limit(limit);
    const results = { observed: 0, accepted: 0, failed: 0 };
    for (const scope of due) {
      const result = await this.deliver(scope, new Date(Math.max(now.getTime(), Date.now())));
      if (!result) continue;
      results.observed++;
      results.accepted += result.accepted;
      if (result.failed) results.failed++;
    }
    return results;
  }

  async deliver(scope: Scope, now = new Date()) {
    // Verify the scoped story before creating a cursor; DB also enforces the FK.
    const [story] = await this.db
      .select({ id: stories.id })
      .from(stories)
      .where(
        and(
          eq(stories.orgId, scope.orgId),
          eq(stories.projectId, scope.projectId),
          eq(stories.id, scope.storyId),
        ),
      )
      .limit(1);
    if (!story) return null;
    await this.db
      .insert(notifications)
      .values({ ...scope, nextAttemptAt: now })
      .onConflictDoNothing();
    const token = randomUUID();
    const scoped = and(
      eq(notifications.storyId, scope.storyId),
      eq(notifications.orgId, scope.orgId),
      eq(notifications.projectId, scope.projectId),
    );
    const [cursor] = await this.db
      .update(notifications)
      .set({ leaseToken: token, leaseUntil: new Date(now.getTime() + LEASE_MS), observedAt: now })
      .where(
        and(
          scoped,
          lte(notifications.nextAttemptAt, now),
          or(isNull(notifications.leaseUntil), lte(notifications.leaseUntil, now)),
        ),
      )
      .returning();
    if (!cursor) return null;
    const owned = and(scoped, eq(notifications.leaseToken, token));
    let accepted = 0;
    try {
      // Never use a destination, installation, URL or payload supplied by an event/agent.
      const [target] = await this.db
        .select({
          repositoryId: projectRepositories.id,
          owner: projectRepositories.owner,
          repo: projectRepositories.name,
          installationId: githubInstallations.installationId,
        })
        .from(projectRepositories)
        .innerJoin(
          githubInstallations,
          and(
            eq(githubInstallations.id, projectRepositories.installationId),
            eq(githubInstallations.orgId, scope.orgId),
            isNull(githubInstallations.suspendedAt),
          ),
        )
        .where(
          and(
            eq(projectRepositories.orgId, scope.orgId),
            eq(projectRepositories.projectId, scope.projectId),
            eq(projectRepositories.role, "primary"),
          ),
        )
        .limit(1);
      if (!target) throw new Error("github_destination_unavailable");
      if (!cursor.pending.length) {
        const snapshot = await readStoryLifecycle(this.db, this.backlog, this.sites, scope, now);
        const changes = lifecycleChanges(snapshot, target.repositoryId, cursor, now);
        const [saved] = await this.db.update(notifications).set(changes).where(owned).returning();
        if (!saved) throw new Error("notification_lease_lost");
        cursor.pending = saved.pending;
      }
      if (cursor.pending.length) {
        const client = await this.github(target.installationId);
        if (!client.request) throw new Error("github_requests_unavailable");
        for (const event of cursor.pending) {
          // Renew before each bounded request. A crash after 204 can replay the
          // SAME eventId: consumers must fetch latest state and be idempotent.
          const [lease] = await this.db
            .update(notifications)
            .set({ leaseUntil: new Date(Date.now() + LEASE_MS) })
            .where(owned)
            .returning({ id: notifications.storyId });
          if (!lease) throw new Error("notification_lease_lost");
          await client.request("POST /repos/{owner}/{repo}/dispatches", {
            owner: target.owner,
            repo: target.repo,
            event_type: `facility.${event.type}`,
            client_payload: { schemaVersion: 1, ...scope, ...event },
            request: { timeout: 15_000, retries: 0 },
          });
          accepted++;
          const remaining = cursor.pending.filter((pending) => pending.eventId !== event.eventId);
          const [saved] = await this.db
            .update(notifications)
            .set({ pending: remaining, lastDeliveredAt: new Date() })
            .where(owned)
            .returning();
          if (!saved) throw new Error("notification_lease_lost");
          cursor.pending = saved.pending;
        }
      }
      await this.db
        .update(notifications)
        .set({
          leaseToken: null,
          leaseUntil: null,
          attempts: 0,
          lastErrorCode: null,
          nextAttemptAt: new Date(now.getTime() + 60_000),
        })
        .where(owned);
      return { accepted, failed: false };
    } catch (error) {
      // Never persist/log request bodies or installation credentials from Octokit.
      const status = (error as { status?: unknown })?.status;
      const known =
        error instanceof Error &&
        [
          "github_destination_unavailable",
          "github_requests_unavailable",
          "notification_lease_lost",
        ].includes(error.message);
      const code =
        typeof status === "number"
          ? `github_http_${status}`
          : known
            ? (error as Error).message
            : "notification_delivery_failed";
      const attempts = cursor.attempts + 1;
      const delay = Math.min(3_600_000, 60_000 * 2 ** Math.min(attempts - 1, 6));
      const nextAttemptAt =
        githubRateLimitRetryAt(error, now.getTime()) ?? new Date(now.getTime() + delay);
      await this.db
        .update(notifications)
        .set({
          leaseToken: null,
          leaseUntil: null,
          attempts,
          lastErrorCode: code,
          nextAttemptAt,
        })
        .where(owned);
      return { accepted, failed: true };
    }
  }
}
