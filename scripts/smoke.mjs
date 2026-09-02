#!/usr/bin/env node
// Read-only smoke test for a running Facility 0.12 control plane.
//   API=https://facility.example FACILITY_API_KEY=fak_... node scripts/smoke.mjs
import process from "node:process";

const API = process.env.API ?? "http://localhost:4400";
const FACILITY_API_KEY = process.env.FACILITY_API_KEY;

function fail(name, detail) {
  console.error(`  ✗ ${name} — ${detail}`);
  process.exit(1);
}

async function request(path) {
  const response = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${FACILITY_API_KEY}` },
  });
  const body = await response.json().catch(() => null);
  return { body, response };
}

async function main() {
  console.log(`Facility 0.12 smoke — ${API}\n`);
  if (!FACILITY_API_KEY) fail("configuration", "FACILITY_API_KEY is required");

  const health = await request("/health");
  if (!health.response.ok || !health.body?.ok) fail("health", JSON.stringify(health.body));
  console.log(`  ✓ health — db ${health.body.db}`);

  const me = await request("/v1/me");
  if (!me.response.ok || !me.body?.principal?.orgId) fail("identity", JSON.stringify(me.body));
  console.log(`  ✓ identity — org ${me.body.principal.orgId}`);

  const projects = await request("/v1/projects");
  if (!projects.response.ok || !Array.isArray(projects.body)) {
    fail("projects", JSON.stringify(projects.body));
  }
  console.log(`  ✓ projects — ${projects.body.length} visible`);

  console.log("\nSMOKE PASSED (3 checks)");
}

main().catch((error) => fail("unexpected", error?.message ?? String(error)));
