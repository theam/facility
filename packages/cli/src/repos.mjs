// `facility repos add-local` registers a Git repository on the machine running
// Facility. Only committed history is ever imported; the command says so, and
// lists what stays behind, before it registers anything.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { banner, bold, dim, heading, item, ok, warn } from "./ui.mjs";

export async function addLocalRepository(flags, positional, version, fetchImpl = fetch) {
  const path = resolve(positional[0] ?? process.cwd());
  const apiUrl = String(flags.api || process.env.FACILITY_API_URL || "http://localhost:4400").replace(
    /\/+$/,
    "",
  );
  const apiKey = process.env.FACILITY_API_KEY;
  const projectId = flags.project || process.env.FACILITY_PROJECT_ID;
  const fail = (code, message) => {
    if (flags.json) console.log(JSON.stringify({ error: { code, message } }));
    else console.error(message);
    return 1;
  };
  if (!apiKey) return fail("api_key_required", "Set FACILITY_API_KEY to an API key with repos:write.");
  if (!projectId) return fail("project_required", "Pass --project=<id> or set FACILITY_PROJECT_ID.");

  const left = uncommitted(path);
  if (!flags.json) {
    banner(version);
    heading("Import contract");
    item("Facility imports committed history from the default branch only.");
    if (left.length) {
      warn(`${left.length} uncommitted or untracked path${left.length === 1 ? "" : "s"} will not be imported:`);
      for (const entry of left.slice(0, 10)) item(dim(`  ${entry}`));
      if (left.length > 10) item(dim(`  … and ${left.length - 10} more`));
    }
  }

  const response = await fetchImpl(`${apiUrl}/v1/projects/${encodeURIComponent(projectId)}/repos/local`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "idempotency-key": `cli-add-local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
    body: JSON.stringify({
      path,
      ...(flags.alias ? { alias: flags.alias } : {}),
      ...(flags.branch ? { defaultBranch: flags.branch } : {}),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return fail(
      payload?.error?.code ?? `http_${response.status}`,
      payload?.error?.message ?? `Facility API request failed (${response.status})`,
    );
  }
  if (flags.json) {
    console.log(JSON.stringify(payload));
    return 0;
  }
  heading("Registered");
  ok(`${bold(payload.manifestName)} → ${payload.sourcePath}`);
  item(`default branch   ${bold(payload.defaultBranch)} at ${payload.headSha?.slice(0, 12)}`);
  item(`role             ${payload.role}`);
  for (const warning of payload.warnings ?? []) warn(warning);
  item(dim(`Use repositories.${payload.role === "primary" ? "primary" : "related"}: ${payload.manifestName} in .facility.yml.`));
  return 0;
}

function uncommitted(path) {
  const result = spawnSync("git", ["-C", path, "status", "--porcelain", "--untracked-files=all"], {
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}
