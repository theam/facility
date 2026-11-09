---
title: Distribute the client plugin
---

# Distribute the client plugin

Give everyone in your organization the Facility client plugin and your instance's MCP endpoint in
one install, pinned to the Facility version you run. Users then follow
[Work from Claude Code or Codex](../guides/client-plugin.md) without entering a URL.

## How it works

The skills live in `plugins/facility` of the Facility repository and ship with every release tag.
Your organization keeps a plugin catalog in a Git repository it controls. One entry in that catalog
points at `plugins/facility` at the tag your instance runs and declares your MCP endpoint.

The plugin directory deliberately has no manifest of its own, so the catalog entry acts as its
manifest. Nothing is copied or generated: upgrading means changing one `ref`.

## Prerequisites

- A Facility release that contains `plugins/facility`. Check a tag with
  `git ls-tree <tag> plugins/facility`.
- The MCP endpoint, `<PUBLIC_URL>/mcp`, with interactive OAuth configured as described in
  [Authentication](authentication.md).
- A Git repository for the catalog that your members can read.

## Claude Code catalog

Add `.claude-plugin/marketplace.json` to the catalog repository. Replace the names, the endpoint
and `vX.Y.Z` with yours; the tag is the Facility version your instance runs:

```json
{
  "name": "example-tools",
  "owner": { "name": "Example Org" },
  "plugins": [
    {
      "name": "facility",
      "description": "Operate Facility stories from Claude Code and Claude Cowork.",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/theam/facility.git",
        "path": "plugins/facility",
        "ref": "vX.Y.Z"
      },
      "mcpServers": {
        "facility": { "type": "http", "url": "https://facility.example.com/mcp" }
      }
    }
  ]
}
```

Run `claude plugin validate .` in the catalog repository before publishing it. Members install with:

```bash
claude plugin marketplace add example-org/example-tools
claude plugin install facility@example-tools
```

To offer the catalog without a manual step, add it with Claude Code's `extraKnownMarketplaces` and
`enabledPlugins` settings, in managed settings or in a repository's `.claude/settings.json`.

## Codex catalog

Codex reads `.agents/plugins/marketplace.json`. The entry is the same, plus the skills directory:

```json
{
  "name": "example-tools",
  "plugins": [
    {
      "name": "facility",
      "description": "Operate Facility stories from Codex.",
      "source": {
        "source": "git-subdir",
        "url": "https://github.com/theam/facility.git",
        "path": "plugins/facility",
        "ref": "vX.Y.Z"
      },
      "skills": "./skills/",
      "mcpServers": {
        "facility": { "type": "http", "url": "https://facility.example.com/mcp" }
      }
    }
  ]
}
```

Members install with:

```bash
codex plugin marketplace add example-org/example-tools
codex plugin add facility@example-tools
codex mcp login facility
```

Codex builds a plugin manifest from the entry's fields when the plugin ships none. Its public
documentation does not describe this behavior, so after a Codex upgrade check that the Facility
server still appears in a new session. A server a member registers with `codex mcp add facility`
takes precedence over the plugin's.

One catalog repository can contain both files. Codex reads its own file before
`.claude-plugin/marketplace.json`.

## Claude organization plugins

On Team and Enterprise plans, Claude organization owners can sync a catalog for claude.ai and
Cowork members from the organization's plugin settings. Organization sync reads the same
`.claude-plugin/marketplace.json` and accepts `git-subdir` sources, but the catalog repository
itself must be private or internal on github.com and gitlab.com; it may still point at the public
Facility repository. Whether organization sync keeps an entry's MCP declaration has not been
verified for this plugin. After the first sync, confirm that the Facility tools appear in a Cowork
session before announcing it.

## Upgrade with Facility

When you upgrade the instance, change `ref` to the new tag in every catalog file in the same change.
Members then update:

```bash
claude plugin marketplace update example-tools
claude plugin update facility@example-tools
```

```bash
codex plugin marketplace upgrade example-tools
codex plugin add facility@example-tools
```

Claude Code does not auto-update third-party catalogs by default. Until members update, their
skills match the previous release; the MCP tools they call still come from the upgraded instance.

## Security

- A catalog contains only the public MCP endpoint. Never put API keys, tokens or client secrets in
  it. Each member signs in with OAuth and the plugin acts with that member's Facility permissions.
- Pin `ref` to a release tag, not a branch, so an upstream change reaches members only when you
  change the catalog.
- The skills require a person to confirm every write and keep plan approval and delivery acceptance
  as interactive confirmations in Facility. They grant no permission beyond the member's own.

## Verify

1. Install from the catalog in a clean Claude Code or Codex profile.
2. Sign in to Facility when prompted, or with `codex mcp login facility`.
3. Ask "What's waiting on me in Facility?" and confirm that the answer lists your projects.
