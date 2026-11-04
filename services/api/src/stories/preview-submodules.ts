import { createHash } from "node:crypto";
import { PreviewConvergenceError } from "./preview-errors.js";

export type PreviewTreeEntry = { mode: string; type: string; sha: string; name: string };
export type PreviewSubmodule = { path: string; repository: string; pin: string };
export type AppliedPreviewRepository = {
  repository: string;
  cwd: string;
  headSha: string;
  submodules: Array<{ path: string; repository: string; pinnedSha: string; headSha: string }>;
};

export function previewSourceFingerprint(sources: AppliedPreviewRepository[]) {
  if (!sources.some((source) => source.submodules.length)) return undefined;
  return createHash("sha256")
    .update(JSON.stringify([...sources].sort((a, b) => a.cwd.localeCompare(b.cwd))))
    .digest("hex");
}

export function previewTreeEntries(output: string): PreviewTreeEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(\d{6}) (blob|tree|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);
      if (!match?.[1] || !match[2] || !match[3] || !match[4]) throw unsafeTopology();
      return { mode: match[1], type: match[2], sha: match[3], name: match[4] };
    });
}

/** Metadata is a relationship hint, never a remote URL to execute or fetch. */
export function connectedPreviewSubmodules(
  config: string,
  entries: PreviewTreeEntry[],
  repository: string,
  connected: ReadonlySet<string>,
): PreviewSubmodule[] {
  const modules = new Map<string, { path?: string; url?: string }>();
  for (const record of config.split("\0").filter(Boolean)) {
    const split = record.indexOf("\n");
    const match = /^submodule\.(.+)\.(path|url)$/.exec(record.slice(0, split));
    if (split < 0 || !match?.[1] || !match[2]) throw unsafeTopology();
    const module = modules.get(match[1]) ?? {};
    const key = match[2] as "path" | "url";
    if (module[key] !== undefined) throw unsafeTopology();
    module[key] = record.slice(split + 1);
    modules.set(match[1], module);
  }
  if (modules.size > 100) throw unsafeTopology();
  const paths = new Set<string>();
  const result: PreviewSubmodule[] = [];
  for (const module of modules.values()) {
    if (!module.path || !module.url || !safePreviewPath(module.path) || paths.has(module.path))
      throw unsafeTopology();
    paths.add(module.path);
    const entry = entries.find((entry) => entry.name === module.path);
    if (entry?.mode !== "160000" || entry.type !== "commit") throw unsafeTopology();
    const name = githubSubmoduleRepository(module.url, repository);
    // Unconnected, unchanged pins remain the parent's responsibility. Never fetch
    // their URLs or expand the installation's configured repository allowlist.
    if (name && connected.has(name))
      result.push({ path: module.path, repository: name, pin: entry.sha });
  }
  for (const path of paths)
    if ([...paths].some((other) => other !== path && other.startsWith(`${path}/`)))
      throw unsafeTopology();
  if (entries.some((entry) => entry.mode === "160000" && !paths.has(entry.name)))
    throw unsafeTopology();
  return result;
}

export function safePreviewPath(value: string) {
  return (
    !value.includes("\\") &&
    ![...value].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    value
      .split("/")
      .every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git")
  );
}

export function githubSubmoduleRepository(value: string, parent: string): string | null {
  let source = value;
  if (source.startsWith("../") || source.startsWith("./")) {
    source = new URL(source, `https://github.com/${parent}.git/`).href;
  }
  source = source.replace(/^git@github\.com:/i, "https://github.com/");
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return null;
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port ||
    url.password ||
    url.search ||
    url.hash ||
    (url.username && !(url.protocol === "ssh:" && url.username === "git"))
  )
    return null;
  const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(url.pathname);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : null;
}

/** Executed inside the runtime before Git follows a retained submodule's .git. */
export const validatePreviewCheckout = `
const fs = require("node:fs");
const path = require("node:path");
try {
  const root = fs.realpathSync(process.cwd());
  const relative = process.argv[1];
  if (!relative || relative.split("/").some(p => !p || p === "." || p === ".." || p.toLowerCase() === ".git") || /[\\\\\\x00-\\x1f\\x7f]/.test(relative)) throw Error();
  let current = root;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw Error();
  }
  const inside = value => value.startsWith(root + path.sep);
  if (!inside(fs.realpathSync(current))) throw Error();
  const marker = path.join(current, ".git");
  const markerStat = fs.lstatSync(marker);
  if (markerStat.isSymbolicLink()) throw Error();
  let directory = marker;
  if (markerStat.isFile()) {
    if (markerStat.size > 4096) throw Error();
    const match = /^gitdir: ([^\\r\\n]+)\\r?\\n?$/.exec(fs.readFileSync(marker, "utf8"));
    if (!match) throw Error();
    directory = path.resolve(current, match[1]);
  } else if (!markerStat.isDirectory()) throw Error();
  directory = fs.realpathSync(directory);
  if (!inside(directory)) throw Error();
  const common = path.join(directory, "commondir");
  if (fs.existsSync(common)) {
    const stat = fs.lstatSync(common);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error();
    if (!inside(fs.realpathSync(path.resolve(directory, fs.readFileSync(common, "utf8").trim())))) throw Error();
  }
  process.stdout.write(current);
} catch { process.exitCode = 1; }
`;

function unsafeTopology() {
  return new PreviewConvergenceError(
    "preview_submodule_topology_invalid",
    "The candidate's submodule paths or metadata cannot be composed safely.",
    false,
  );
}
