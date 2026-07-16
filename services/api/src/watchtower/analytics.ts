import { agentDefs, analyticsDaily, createDb, type FacilityDb, projects } from "@facility/db";
import { and, eq, gte, lte, sql } from "drizzle-orm";
import type { AppConfig } from "../types.js";

export type AnalyticsGroupBy = "day" | "agent" | "model";

// The scheduled rollup runs hourly. runs/llm_requests/outcomes are all
// append-at-now (created_at / terminal_at are set at insert and never
// backdated), so a day's bucket stops changing once that day passes — an
// hourly full 90-day rebuild is pure waste. Rebuild only the trailing window,
// which is index-supported (runs.created_at / outcomes.terminal_at). Widen it
// (e.g. sinceDays: 3650) for a one-time backfill on imported/restored data.
const DEFAULT_ROLLUP_WINDOW_DAYS = 3;

function resolveWindowDays(raw: string | undefined): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_ROLLUP_WINDOW_DAYS;
}

export async function runAnalyticsRollup(config: AppConfig, options: { sinceDays?: number } = {}) {
  const { db, client } = createDb(config.databaseUrl);
  try {
    await rollupAnalytics(db, {
      sinceDays: options.sinceDays ?? resolveWindowDays(process.env.ANALYTICS_ROLLUP_WINDOW_DAYS),
    });
  } finally {
    await client.end();
  }
}

export async function rollupAnalytics(db: FacilityDb, options: { sinceDays?: number } = {}) {
  const sinceDays = Math.max(1, Math.floor(options.sinceDays ?? DEFAULT_ROLLUP_WINDOW_DAYS));
  // One bound reused across the DELETE and all three INSERT predicates so the
  // deleted window and the rebuilt window are always identical.
  const since = sql`(current_date - make_interval(days => ${sinceDays}::int))`;
  await db.execute(sql`
    delete from analytics_daily
    where day >= ${since}::date
  `);
  await db.execute(sql`
    insert into analytics_daily (
      id,
      org_id,
      project_id,
      day,
      agent_def_id,
      model,
      runs_started,
      runs_succeeded,
      runs_failed,
      input_tokens,
      output_tokens,
      cache_read,
      cache_write,
      cost_cents,
      outcomes_total,
      outcomes_assessed,
      outcomes_accepted,
      outcomes_merged,
      outcomes_one_shot,
      updated_at
    )
    with rows as (
      select
        r.org_id,
        r.project_id,
        date_trunc('day', r.created_at)::date as day,
        r.agent_def_id,
        coalesce(ad.model->>'name', ad.model->>'model', r.engine, 'none') as model,
        count(*)::int as runs_started,
        count(*) filter (where r.status = 'succeeded')::int as runs_succeeded,
        count(*) filter (where r.status in ('failed', 'canceled'))::int as runs_failed,
        0::bigint as input_tokens,
        0::bigint as output_tokens,
        0::bigint as cache_read,
        0::bigint as cache_write,
        0::numeric as cost_cents,
        0::int as outcomes_total,
        0::int as outcomes_assessed,
        0::int as outcomes_accepted,
        0::int as outcomes_merged,
        0::int as outcomes_one_shot
      from runs r
      left join agent_defs ad on ad.id = r.agent_def_id
      where r.created_at >= ${since}::timestamptz
      group by 1, 2, 3, 4, 5

      union all

      select
        lr.org_id,
        lr.project_id,
        date_trunc('day', lr.created_at)::date as day,
        r.agent_def_id,
        lr.model,
        0::int,
        0::int,
        0::int,
        coalesce(sum(lr.input_tokens), 0)::bigint,
        coalesce(sum(lr.output_tokens), 0)::bigint,
        coalesce(sum(lr.cache_read), 0)::bigint,
        coalesce(sum(lr.cache_write), 0)::bigint,
        coalesce(sum(lr.cost_cents), 0)::numeric,
        0::int,
        0::int,
        0::int,
        0::int,
        0::int
      from llm_requests lr
      left join runs r on r.id = lr.run_id
      where lr.created_at >= ${since}::timestamptz
      group by 1, 2, 3, 4, 5

      union all

      select
        o.org_id,
        o.project_id,
        date_trunc('day', o.terminal_at)::date as day,
        null::text as agent_def_id,
        'outcomes' as model,
        0::int,
        0::int,
        0::int,
        0::numeric,
        0::bigint,
        0::bigint,
        0::bigint,
        0::bigint,
        count(*)::int,
        count(*) filter (where o.accepted is not null)::int,
        count(*) filter (where o.accepted = true)::int,
        count(*) filter (where o.fate = 'merged')::int,
        count(*) filter (
          where o.fate = 'merged' and o.review_rounds = 0 and o.fixup_commits = 0
        )::int
      from outcomes o
      where o.terminal_at >= ${since}::timestamptz
      group by 1, 2, 3, 4, 5
    ),
    grouped as (
      select
        org_id,
        project_id,
        day,
        agent_def_id,
        model,
        sum(runs_started)::int as runs_started,
        sum(runs_succeeded)::int as runs_succeeded,
        sum(runs_failed)::int as runs_failed,
        sum(input_tokens)::bigint as input_tokens,
        sum(output_tokens)::bigint as output_tokens,
        sum(cache_read)::bigint as cache_read,
        sum(cache_write)::bigint as cache_write,
        sum(cost_cents)::numeric as cost_cents,
        sum(outcomes_total)::int as outcomes_total,
        sum(outcomes_assessed)::int as outcomes_assessed,
        sum(outcomes_accepted)::int as outcomes_accepted,
        sum(outcomes_merged)::int as outcomes_merged,
        sum(outcomes_one_shot)::int as outcomes_one_shot
      from rows
      group by 1, 2, 3, 4, 5
    )
    select
      'ad_' || substr(md5(org_id || ':' || project_id || ':' || day::text || ':' || coalesce(agent_def_id, '__none__') || ':' || model), 1, 24),
      org_id,
      project_id,
      day,
      agent_def_id,
      model,
      runs_started,
      runs_succeeded,
      runs_failed,
      input_tokens,
      output_tokens,
      cache_read,
      cache_write,
      cost_cents,
      outcomes_total,
      outcomes_assessed,
      outcomes_accepted,
      outcomes_merged,
      outcomes_one_shot,
      now()
    from grouped
    on conflict (org_id, project_id, day, coalesce(agent_def_id, '__none__'), model)
    do update set
      runs_started = excluded.runs_started,
      runs_succeeded = excluded.runs_succeeded,
      runs_failed = excluded.runs_failed,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_read = excluded.cache_read,
      cache_write = excluded.cache_write,
      cost_cents = excluded.cost_cents,
      outcomes_total = excluded.outcomes_total,
      outcomes_assessed = excluded.outcomes_assessed,
      outcomes_accepted = excluded.outcomes_accepted,
      outcomes_merged = excluded.outcomes_merged,
      outcomes_one_shot = excluded.outcomes_one_shot,
      updated_at = now()
  `);
}

export async function queryAnalytics(
  db: FacilityDb,
  orgId: string,
  query: {
    projectId?: string;
    from?: string;
    to?: string;
    groupBy: AnalyticsGroupBy;
    limit: number;
    offset: number;
  },
) {
  const clauses = [eq(analyticsDaily.orgId, orgId)];
  if (query.projectId) clauses.push(eq(analyticsDaily.projectId, query.projectId));
  if (query.from) clauses.push(gte(analyticsDaily.day, query.from));
  if (query.to) clauses.push(lte(analyticsDaily.day, query.to));
  const bucket =
    query.groupBy === "day"
      ? sql<string>`${analyticsDaily.day}::text`
      : query.groupBy === "agent"
        ? sql<string>`coalesce(${analyticsDaily.agentDefId}, 'none')`
        : analyticsDaily.model;
  const rows = await db
    .select({
      bucket,
      runsStarted: sql<number>`coalesce(sum(${analyticsDaily.runsStarted}), 0)::int`,
      runsSucceeded: sql<number>`coalesce(sum(${analyticsDaily.runsSucceeded}), 0)::int`,
      runsFailed: sql<number>`coalesce(sum(${analyticsDaily.runsFailed}), 0)::int`,
      inputTokens: sql<number>`coalesce(sum(${analyticsDaily.inputTokens}), 0)::bigint`,
      outputTokens: sql<number>`coalesce(sum(${analyticsDaily.outputTokens}), 0)::bigint`,
      costCents: sql<number>`floor(coalesce(sum(${analyticsDaily.costCents}), 0) + 0.5)::bigint`,
      outcomesTotal: sql<number>`coalesce(sum(${analyticsDaily.outcomesTotal}), 0)::int`,
      outcomesAssessed: sql<number>`coalesce(sum(${analyticsDaily.outcomesAssessed}), 0)::int`,
      outcomesAccepted: sql<number>`coalesce(sum(${analyticsDaily.outcomesAccepted}), 0)::int`,
      outcomesMerged: sql<number>`coalesce(sum(${analyticsDaily.outcomesMerged}), 0)::int`,
      outcomesOneShot: sql<number>`coalesce(sum(${analyticsDaily.outcomesOneShot}), 0)::int`,
      acceptance: sql<
        number | null
      >`case when sum(${analyticsDaily.outcomesAssessed}) > 0 then round(100.0 * sum(${analyticsDaily.outcomesAccepted}) / sum(${analyticsDaily.outcomesAssessed}))::int else null end`,
      oneShot: sql<
        number | null
      >`case when sum(${analyticsDaily.outcomesMerged}) > 0 then round(100.0 * sum(${analyticsDaily.outcomesOneShot}) / sum(${analyticsDaily.outcomesMerged}))::int else null end`,
    })
    .from(analyticsDaily)
    .where(and(...clauses))
    .groupBy(bucket)
    .orderBy(bucket)
    .limit(query.limit)
    .offset(query.offset);
  return rows.map((row) => ({
    ...row,
    runsStarted: Number(row.runsStarted),
    runsSucceeded: Number(row.runsSucceeded),
    runsFailed: Number(row.runsFailed),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    costCents: Number(row.costCents),
    outcomesTotal: Number(row.outcomesTotal),
    outcomesAssessed: Number(row.outcomesAssessed),
    outcomesAccepted: Number(row.outcomesAccepted),
    outcomesMerged: Number(row.outcomesMerged),
    outcomesOneShot: Number(row.outcomesOneShot),
  }));
}

export async function analyticsOverview(
  db: FacilityDb,
  orgId: string,
  projectId?: string,
  page: { limit: number; offset: number } = { limit: 100, offset: 0 },
) {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10);
  const agentClauses = [eq(agentDefs.orgId, orgId), eq(agentDefs.enabled, true)];
  if (projectId) agentClauses.push(eq(agentDefs.projectId, projectId));
  const liveAgents =
    (
      await db
        .select({ count: sql<number>`count(*)::int` })
        .from(agentDefs)
        .where(and(...agentClauses))
    )[0]?.count ?? 0;
  const mtdClauses = [
    eq(analyticsDaily.orgId, orgId),
    gte(analyticsDaily.day, monthStart.toISOString().slice(0, 10)),
  ];
  if (projectId) mtdClauses.push(eq(analyticsDaily.projectId, projectId));
  const spendMtd = Number(
    (
      await db
        .select({
          cents: sql<number>`floor(coalesce(sum(${analyticsDaily.costCents}), 0) + 0.5)::bigint`,
        })
        .from(analyticsDaily)
        .where(and(...mtdClauses))
    )[0]?.cents ?? 0,
  );
  const outcomeClauses = [eq(analyticsDaily.orgId, orgId), gte(analyticsDaily.day, thirtyDaysAgo)];
  if (projectId) outcomeClauses.push(eq(analyticsDaily.projectId, projectId));
  const rawOutcomeTotals = (
    await db
      .select({
        total: sql<number>`coalesce(sum(${analyticsDaily.outcomesTotal}), 0)::int`,
        assessed: sql<number>`coalesce(sum(${analyticsDaily.outcomesAssessed}), 0)::int`,
        accepted: sql<number>`coalesce(sum(${analyticsDaily.outcomesAccepted}), 0)::int`,
        merged: sql<number>`coalesce(sum(${analyticsDaily.outcomesMerged}), 0)::int`,
        oneShot: sql<number>`coalesce(sum(${analyticsDaily.outcomesOneShot}), 0)::int`,
      })
      .from(analyticsDaily)
      .where(and(...outcomeClauses))
  )[0] ?? { total: 0, assessed: 0, accepted: 0, merged: 0, oneShot: 0 };
  const outcomeTotals = {
    total: Number(rawOutcomeTotals.total),
    assessed: Number(rawOutcomeTotals.assessed),
    accepted: Number(rawOutcomeTotals.accepted),
    merged: Number(rawOutcomeTotals.merged),
    oneShot: Number(rawOutcomeTotals.oneShot),
  };
  const perProject = await db
    .select({
      projectId: projects.id,
      projectName: projects.name,
      spendCents: sql<number>`floor(coalesce(sum(${analyticsDaily.costCents}), 0) + 0.5)::bigint`,
      runsStarted: sql<number>`coalesce(sum(${analyticsDaily.runsStarted}), 0)::int`,
      outcomesTotal: sql<number>`coalesce(sum(${analyticsDaily.outcomesTotal}), 0)::int`,
      outcomesAssessed: sql<number>`coalesce(sum(${analyticsDaily.outcomesAssessed}), 0)::int`,
      outcomesAccepted: sql<number>`coalesce(sum(${analyticsDaily.outcomesAccepted}), 0)::int`,
      outcomesMerged: sql<number>`coalesce(sum(${analyticsDaily.outcomesMerged}), 0)::int`,
      outcomesOneShot: sql<number>`coalesce(sum(${analyticsDaily.outcomesOneShot}), 0)::int`,
    })
    .from(projects)
    .leftJoin(
      analyticsDaily,
      and(eq(analyticsDaily.projectId, projects.id), gte(analyticsDaily.day, thirtyDaysAgo)),
    )
    .where(
      projectId
        ? and(eq(projects.orgId, orgId), eq(projects.id, projectId))
        : eq(projects.orgId, orgId),
    )
    .groupBy(projects.id, projects.name)
    .orderBy(projects.name, projects.id)
    .limit(page.limit)
    .offset(page.offset);
  return {
    liveAgents,
    spendMtdCents: spendMtd,
    outcomes30d: outcomeTotals,
    acceptance30d:
      outcomeTotals.assessed > 0
        ? Math.round((100 * outcomeTotals.accepted) / outcomeTotals.assessed)
        : null,
    oneShot30d:
      outcomeTotals.merged > 0
        ? Math.round((100 * outcomeTotals.oneShot) / outcomeTotals.merged)
        : null,
    projects: perProject.map((project) => ({
      ...project,
      spendCents: Number(project.spendCents),
      runsStarted: Number(project.runsStarted),
      outcomesTotal: Number(project.outcomesTotal),
      outcomesAssessed: Number(project.outcomesAssessed),
      outcomesAccepted: Number(project.outcomesAccepted),
      outcomesMerged: Number(project.outcomesMerged),
      outcomesOneShot: Number(project.outcomesOneShot),
    })),
  };
}
