import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "index",
    "roadmap",
    "faq",
    {
      type: "category",
      label: "concepts",
      collapsed: false,
      items: ["concepts/stories-and-workspaces", "concepts/agents-as-code"],
    },
    {
      type: "category",
      label: "self-hosting",
      collapsed: false,
      items: [
        "self-host/quickstart",
        "self-host/local-development",
        "self-host/production",
        "self-host/authentication",
        "self-host/github-app",
      ],
    },
    {
      type: "category",
      label: "guides",
      collapsed: false,
      items: ["guides/kickstart", "guides/validate-workspace-loop"],
    },
    {
      type: "category",
      label: "reference",
      items: [
        "reference/architecture",
        "reference/api",
        "reference/cli",
        "reference/mcp",
        "reference/webhooks",
        "reference/security",
        "reference/upgrade-012",
        {
          type: "category",
          label: "decisions",
          items: [
            "reference/decisions/persistent-workspace-provider",
            "reference/decisions/workspace-runtime",
            "reference/decisions/mcp-authentication",
            "reference/decisions/engine-credentials",
            "reference/decisions/authenticated-preview",
            "reference/decisions/multi-repository-stories",
            "reference/decisions/storage-and-deletion",
          ],
        },
      ],
    },
  ],
};

export default sidebars;
