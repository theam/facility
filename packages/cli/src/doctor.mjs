import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { banner, heading, item, ok, warn } from "./ui.mjs";

export async function doctor(flags, version) {
  const dir = flags.dir || process.cwd();
  const checks = [checkProjectManifest(dir), ...checkAgentCatalog(dir)];
  const problems = checks.filter((check) => !check.ok).length;
  const result = { mode: "local", ok: problems === 0, problems, checks };

  if (flags.json) {
    console.log(JSON.stringify(result));
    return result.ok ? 0 : 1;
  }

  banner(version);
  heading("Workspace contract");
  for (const check of checks) {
    if (check.ok) ok(`${check.label}: ${check.detail}`);
    else warn(`${check.label}: ${check.detail}`);
  }
  item(result.ok ? "Facility can create a story workspace from this repository." : `${problems} problem${problems === 1 ? "" : "s"} found.`);
  return result.ok ? 0 : 1;
}

function checkProjectManifest(dir) {
  const path = join(dir, ".facility.yml");
  if (!existsSync(path)) return failed("start command", ".facility.yml is missing");
  const source = readFileSync(path, "utf8");
  if (!/^version:\s*1\s*$/m.test(source)) return failed("start command", "version must be 1");
  if (!/^\s{2}primary:\s*["']?github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+["']?\s*$/m.test(source)) {
    return failed("start command", "repositories.primary must be github.com/owner/repository");
  }
  if (!/^\s{2}start:\s*["']?.+$/m.test(source)) return failed("start command", "environment.start is missing");
  const servicePort = /^\s{6}port:\s*([1-9]\d{0,4})\s*$/m.exec(source);
  if (!servicePort || Number(servicePort[1]) > 65_535) {
    return failed("start command", "a service port between 1 and 65535 is required");
  }
  return passed("start command", ".facility.yml declares the repository and development environment");
}

// Validate every manifest the server loads (top-level .agents/*.md), not only the starter crew.
function checkAgentCatalog(dir) {
  const directory = join(dir, ".agents");
  const files = existsSync(directory)
    ? readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
        .map((entry) => entry.name)
        .sort()
    : [];
  if (files.length === 0) return [failed(".agents/", "missing: no agent manifests (.agents/*.md)")];
  return files.map((file) => checkAgent(dir, file));
}

function checkAgent(dir, file) {
  const relative = `.agents/${file}`;
  const name = file.slice(0, -".md".length);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64) {
    return failed(relative, "filename must be a lowercase kebab-case agent name of at most 64 characters");
  }
  const source = readFileSync(join(dir, relative), "utf8").replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n") || !/\n---\n[\s\S]*\S/.test(source)) return failed(relative, "invalid frontmatter or empty prompt");
  if (!new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, "m").test(source)) return failed(relative, `name must be ${name} to match the filename`);
  if (!/^engine:\s*(?:claude_code|codex)\s*$/m.test(source)) return failed(relative, "engine must be claude_code or codex");
  if (!/^model:\s*\S+\s*$/m.test(source)) return failed(relative, "model is missing");
  if (!/^triggers:\s*$/m.test(source) || !/^\s{2}- type:\s*(?:manual|mcp|ui|schedule|github)\s*$/m.test(source)) {
    return failed(relative, "at least one supported trigger is required");
  }
  if (/^(?:permissions|sandbox|tools):/m.test(source)) return failed(relative, "per-agent access controls are not supported");
  return passed(relative, "valid agent manifest");
}

function passed(label, detail) {
  return { label, ok: true, detail };
}

function failed(label, detail) {
  return { label, ok: false, detail };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
