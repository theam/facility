import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { banner, heading, item, ok, warn } from "./ui.mjs";

const AGENTS = [
  "architect",
  "builder",
  "pr-reviewer",
  "address-review",
  "ci-doctor",
  "security-audit",
];

export async function doctor(flags, version) {
  const dir = flags.dir || process.cwd();
  const checks = [checkProjectManifest(dir), ...AGENTS.map((name) => checkAgent(dir, name))];
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

function checkAgent(dir, name) {
  const relative = `.agents/${name}.md`;
  const path = join(dir, relative);
  if (!existsSync(path)) return failed(relative, "missing");
  const source = readFileSync(path, "utf8").replace(/\r\n?/g, "\n");
  if (!source.startsWith("---\n") || !/\n---\n[\s\S]*\S/.test(source)) return failed(relative, "invalid frontmatter or empty prompt");
  if (!new RegExp(`^name:\\s*${escapeRegExp(name)}\\s*$`, "m").test(source)) return failed(relative, `name must be ${name}`);
  if (!/^engine:\s*(?:claude_code|codex)\s*$/m.test(source)) return failed(relative, "engine must be claude_code or codex");
  if (!/^model:\s*\S+\s*$/m.test(source)) return failed(relative, "model is missing");
  if (!/^triggers:\s*$/m.test(source) || !/^\s{2}- type:\s*(?:manual|schedule|github)\s*$/m.test(source)) {
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
