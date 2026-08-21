import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import nodePath, { extname, resolve } from "node:path";

import { readText } from "./_kit.mjs";

function trackedMarkdownFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter((file) => /\.(?:md|markdown)$/i.test(file));
}

function withoutInlineCode(line) {
  const masked = line.split("");
  for (let start = 0; start < line.length; start += 1) {
    if (line[start] !== "`") continue;

    let width = 1;
    while (line[start + width] === "`") width += 1;

    let end = start + width;
    while (end < line.length) {
      if (line[end] !== "`") {
        end += 1;
        continue;
      }
      let closingWidth = 1;
      while (line[end + closingWidth] === "`") closingWidth += 1;
      if (closingWidth === width) break;
      end += closingWidth;
    }

    if (end >= line.length) {
      start += width - 1;
      continue;
    }
    masked.fill(" ", start, end + width);
    start = end + width - 1;
  }
  return masked.join("");
}

function isEscaped(line, index) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function inlineTargets(line) {
  const targets = [];
  for (let index = 0; index < line.length - 1; index += 1) {
    if (line[index] !== "]" || line[index + 1] !== "(" || isEscaped(line, index)) continue;

    let cursor = index + 2;
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
    let target = "";

    if (line[cursor] === "<") {
      cursor += 1;
      while (cursor < line.length && line[cursor] !== ">") {
        target += line[cursor];
        cursor += 1;
      }
      if (line[cursor] === ">") targets.push(target);
      continue;
    }

    let depth = 0;
    while (cursor < line.length) {
      const character = line[cursor];
      if (character === "\\" && cursor + 1 < line.length) {
        target += line[cursor + 1];
        cursor += 2;
        continue;
      }
      if (character === "(") depth += 1;
      if (character === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      if (/\s/.test(character) && depth === 0) break;
      target += character;
      cursor += 1;
    }
    targets.push(target);
  }
  return targets;
}

function referenceTarget(line) {
  const match = line.match(/^ {0,3}\[([^\]]+)\]:[ \t]*(.*)$/);
  if (!match || match[1].startsWith("^")) return null;

  const rest = match[2];
  if (rest.startsWith("<")) {
    const end = rest.indexOf(">");
    return end === -1 ? null : rest.slice(1, end);
  }
  return rest.match(/^(?:\\.|\S)+/)?.[0].replace(/\\(.)/g, "$1") ?? null;
}

function localPath(target) {
  if (
    !target ||
    target.startsWith("#") ||
    target.startsWith("?") ||
    target.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(target)
  ) {
    return null;
  }

  const separator = target.search(/[?#]/);
  const path = separator === -1 ? target : target.slice(0, separator);
  if (!path) return null;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/**
 * Resolve a link target against the repository, or null when it escapes the
 * repository.
 *
 * `root` is normalised before the containment comparison because
 * `git rev-parse --show-toplevel` reports POSIX separators on every platform:
 * on Windows it answers `C:/repo` while `path.resolve` produces `C:\repo`, so
 * comparing them directly rejects every in-repo target.
 *
 * `path` is injectable so the platform-specific behaviour can be tested from
 * any host.
 */
export function resolveWithinRoot(root, source, target, path = nodePath) {
  const base = path.resolve(root);
  const exact = path.resolve(base, path.dirname(source), target);
  if (exact !== base && !exact.startsWith(`${base}${path.sep}`)) return null;
  return exact;
}

function targetExists(root, source, target) {
  const exact = resolveWithinRoot(root, source, target);
  if (exact === null) return false;

  const withoutSlash = exact.replace(/[\\/]+$/, "");
  const candidates = [exact];
  if (!extname(withoutSlash)) {
    candidates.push(`${withoutSlash}.md`, resolve(withoutSlash, "index.md"));
  }
  return candidates.some((candidate) => existsSync(candidate));
}

export default {
  name: "markdown-links",
  description: "tracked Markdown files do not link to missing local targets",
  run() {
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
    }).trim();
    const violations = [];

    for (const file of trackedMarkdownFiles(root)) {
      let fence = null;
      const lines = readText(resolve(root, file)).split("\n");
      lines.forEach((rawLine, index) => {
        const line = rawLine.replace(/^(?: {0,3}>[ \t]?)+/, "");
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})/i)?.[1];
        if (fence) {
          if (
            marker?.[0] === fence.character &&
            marker.length >= fence.width &&
            line.slice(line.indexOf(marker) + marker.length).trim() === ""
          ) {
            fence = null;
          }
          return;
        }
        if (marker) {
          fence = { character: marker[0], width: marker.length };
          return;
        }

        const visible = withoutInlineCode(line);
        const targets = inlineTargets(visible);
        const definition = referenceTarget(visible);
        if (definition !== null) targets.push(definition);

        for (const rawTarget of targets) {
          const target = localPath(rawTarget);
          if (target === null || targetExists(root, file, target)) continue;
          violations.push({
            file,
            line: index + 1,
            message: `local Markdown target "${rawTarget}" does not exist`,
          });
        }
      });
    }
    return violations;
  },
};
