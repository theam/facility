#!/usr/bin/env node
// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: this CI policy command consumes the checked commit range.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_PREFIX = "packages/db/migrations/";
const DESTRUCTIVE_PATTERNS = Object.freeze([
  ["drop table/schema/database", /\bDROP\s+(?:TABLE|SCHEMA|DATABASE)\b/i],
  ["truncate data", /\bTRUNCATE(?:\s+TABLE)?\b/i],
  ["drop column", /\bALTER\s+TABLE\b[^;]*\bDROP\s+COLUMN\b/i],
  ["rename table/column", /\bALTER\s+TABLE\b[^;]*\bRENAME\s+(?:COLUMN\b|TO\b)/i],
  ["change column type", /\bALTER\s+TABLE\b[^;]*\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i],
]);

function command(gitCommand, args, { cwd } = {}) {
  const result = spawnSync(gitCommand, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${gitCommand} ${args.slice(0, 2).join(" ")} failed: ${result.stderr.trim() || `exit ${result.status}`}`,
    );
  }
  return result.stdout;
}

// Remove comments and quoted values before matching DDL keywords. Keeping
// punctuation and whitespace preserves statement boundaries without pretending
// to be a complete PostgreSQL parser.
export function executableSql(sql) {
  let output = "";
  let mode = "code";
  let blockDepth = 0;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];

    if (mode === "line-comment") {
      if (character === "\n") {
        output += "\n";
        mode = "code";
      } else {
        output += " ";
      }
      continue;
    }
    if (mode === "block-comment") {
      if (character === "/" && next === "*") {
        blockDepth += 1;
        output += "  ";
        index += 1;
      } else if (character === "*" && next === "/") {
        blockDepth -= 1;
        output += "  ";
        index += 1;
        if (blockDepth === 0) mode = "code";
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (mode === "single-quote" || mode === "escape-string" || mode === "double-quote") {
      const quote = mode === "double-quote" ? '"' : "'";
      if (character === quote && next === quote) {
        output += "  ";
        index += 1;
      } else if (mode === "escape-string" && character === "\\" && next !== undefined) {
        output += next === "\n" ? " \n" : "  ";
        index += 1;
      } else if (character === quote) {
        output += " ";
        mode = "code";
      } else {
        output += character === "\n" ? "\n" : " ";
      }
      continue;
    }

    if (character === "-" && next === "-") {
      output += "  ";
      index += 1;
      mode = "line-comment";
    } else if (character === "/" && next === "*") {
      output += "  ";
      index += 1;
      blockDepth = 1;
      mode = "block-comment";
    } else if (
      (character === "E" || character === "e") &&
      next === "'" &&
      !/[A-Za-z0-9_$]/.test(sql[index - 1] || "")
    ) {
      output += "  ";
      index += 1;
      mode = "escape-string";
    } else if (character === "'") {
      output += " ";
      mode = "single-quote";
    } else if (character === '"') {
      output += " ";
      mode = "double-quote";
    } else {
      output += character;
    }
  }
  return output;
}

export function destructiveMigrationFindings(sql) {
  const executable = executableSql(sql);
  return DESTRUCTIVE_PATTERNS.filter(([, pattern]) => pattern.test(executable)).map(
    ([description]) => description,
  );
}

export function migrationChanges({ base, head, gitCommand = "git", rootDir }) {
  const comparisonBase = /^0{40,64}$/.test(base)
    ? command(gitCommand, ["mktree"], { cwd: rootDir }).trim()
    : command(gitCommand, ["merge-base", base, head], { cwd: rootDir }).trim();
  if (!comparisonBase) throw new Error(`git could not find a merge base for ${base} and ${head}`);
  const output = command(
    gitCommand,
    ["diff", "--name-status", "-z", comparisonBase, head, "--", "packages/db/migrations"],
    { cwd: rootDir },
  );
  const fields = output.split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    const path = fields[index++];
    if (!status || !path) throw new Error("git returned malformed migration change metadata");
    if (status.startsWith("R") || status.startsWith("C")) {
      const destination = fields[index++];
      if (!destination) throw new Error("git returned an incomplete migration rename");
      changes.push({ destination, path, status });
    } else {
      changes.push({ path, status });
    }
  }
  return changes.filter(
    ({ destination, path }) =>
      path.startsWith(MIGRATIONS_PREFIX) || destination?.startsWith(MIGRATIONS_PREFIX),
  );
}

function defaultRange(gitCommand, rootDir) {
  const head = process.env.HEAD_SHA || "HEAD";
  if (process.env.BASE_SHA) return { base: process.env.BASE_SHA, head };
  try {
    return {
      base: command(gitCommand, ["merge-base", head, "origin/main"], { cwd: rootDir }).trim(),
      head,
    };
  } catch {
    return { base: `${head}^`, head };
  }
}

export async function checkMigrationChanges({ base, head, gitCommand = "git", rootDir = "." }) {
  const changes = migrationChanges({ base, head, gitCommand, rootDir });
  const immutableViolations = changes.filter(({ status }) => status !== "A");
  if (immutableViolations.length > 0) {
    throw new Error(
      `applied migration files are immutable: ${immutableViolations
        .map(
          ({ destination, path, status }) =>
            `${status} ${path}${destination ? ` -> ${destination}` : ""}`,
        )
        .join(", ")}`,
    );
  }

  const unsafe = [];
  for (const { path } of changes) {
    if (!path.endsWith(".sql")) continue;
    const findings = destructiveMigrationFindings(await readFile(resolve(rootDir, path), "utf8"));
    if (findings.length > 0) unsafe.push({ findings, path });
  }
  if (unsafe.length > 0) {
    throw new Error(
      `new migrations must be expand-compatible so the previous release remains rollback-safe: ${unsafe
        .map(({ findings, path }) => `${path} (${findings.join(", ")})`)
        .join("; ")}`,
    );
  }
  return { checked: changes.filter(({ path }) => path.endsWith(".sql")).length };
}

async function main([commandName, baseArgument, headArgument, ...extra]) {
  if (commandName !== "check" || extra.length > 0) {
    throw new Error("usage: migrations.mjs check [base-sha] [head-sha]");
  }
  const defaults = defaultRange("git", ".");
  const result = await checkMigrationChanges({
    base: baseArgument || defaults.base,
    head: headArgument || defaults.head,
  });
  console.log(JSON.stringify({ event: "facility.migrations.compatibility", ...result }));
}

const thisFile = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === thisFile) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
