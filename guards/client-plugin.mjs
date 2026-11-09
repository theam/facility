// The client plugin in plugins/facility is installed through catalog entries
// that act as its manifest: Facility's own catalogs and every organization's
// catalog, which declares that organization's MCP endpoint. Claude Code and
// Codex take MCP servers from an entry only when the plugin ships no manifest,
// so a manifest added here would silently disconnect every organization.
// Facility's catalogs must not name an instance either: Claude Code asks for
// the endpoint at install time and Codex users register it themselves.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { readText } from "./_kit.mjs";

const PLUGIN = "plugins/facility";
const MANIFESTS = [".claude-plugin", ".codex-plugin", ".cursor-plugin", ".mcp.json"];
const CATALOGS = {
  claude: ".claude-plugin/marketplace.json",
  codex: ".agents/plugins/marketplace.json",
};
const GATES_HEADING = "## Human gates";

function section(text, heading) {
  const start = text.indexOf(`\n${heading}\n`);
  if (start === -1) return null;
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", heading.length);
  return next === -1 ? rest : rest.slice(0, next);
}

function catalogEntry(file, violations) {
  let catalog;
  try {
    catalog = JSON.parse(readText(file));
  } catch (error) {
    violations.push({ file, message: `catalog is not valid JSON: ${error.message}` });
    return null;
  }
  const entry = catalog.plugins?.find((plugin) => plugin.name === "facility");
  if (!entry) {
    violations.push({ file, message: 'catalog must list the "facility" plugin' });
    return null;
  }
  if (entry.source !== `./${PLUGIN}`) {
    violations.push({ file, message: `"facility" source must be "./${PLUGIN}"` });
  }
  return entry;
}

export default {
  name: "client-plugin",
  description: "the client plugin has no manifest and its catalogs name no Facility instance",
  run() {
    const violations = [];

    for (const manifest of MANIFESTS) {
      const path = join(PLUGIN, manifest);
      if (existsSync(path)) {
        violations.push({
          file: path,
          message: "the catalog entry is the plugin manifest; a manifest here drops MCP endpoints",
        });
      }
    }

    const skillsDir = join(PLUGIN, "skills");
    const skills = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    if (skills.length === 0) violations.push({ file: skillsDir, message: "no skills found" });
    let gates = null;
    for (const skill of skills) {
      const file = join(skillsDir, skill, "SKILL.md");
      const text = readText(file);
      const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? "";
      if (!new RegExp(`^name: ${skill}$`, "m").test(frontmatter)) {
        violations.push({ file, message: `frontmatter name must be "${skill}"` });
      }
      if (!/^description: \S/m.test(frontmatter)) {
        violations.push({ file, message: "frontmatter needs a description" });
      }
      const block = section(text, GATES_HEADING);
      if (block === null) {
        violations.push({ file, message: `missing the "${GATES_HEADING}" section` });
      } else if (gates === null) {
        gates = block;
      } else if (block !== gates) {
        violations.push({ file, message: `"${GATES_HEADING}" differs from the other skills` });
      }
    }

    const claude = catalogEntry(CATALOGS.claude, violations);
    if (claude) {
      if (claude.mcpServers?.facility?.url !== "${user_config.mcp_url}") {
        violations.push({
          file: CATALOGS.claude,
          message: "the facility MCP URL must come from the mcp_url install option",
        });
      }
      if (claude.userConfig?.mcp_url?.required !== true) {
        violations.push({ file: CATALOGS.claude, message: "mcp_url must be a required option" });
      }
    }

    const codex = catalogEntry(CATALOGS.codex, violations);
    if (codex?.mcpServers) {
      violations.push({
        file: CATALOGS.codex,
        message: "Codex cannot ask for the endpoint; users register the MCP server themselves",
      });
    }

    return violations;
  },
};
