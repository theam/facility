import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

const sidebars: SidebarsConfig = {
  docs: [
    "index",
    "roadmap",
    {
      type: "category",
      label: "concepts",
      collapsed: false,
      items: [
        "concepts/the-loop",
        "concepts/projects-and-governance",
        "concepts/sandboxes",
        "concepts/gateway-and-cost",
        "concepts/registry",
        "concepts/watchtower",
        "concepts/inbox",
        "concepts/knowledge",
      ],
    },
    {
      type: "category",
      label: "self-hosting",
      collapsed: false,
      items: ["self-host/quickstart", "self-host/production", "self-host/aws"],
    },
    {
      type: "category",
      label: "guides",
      collapsed: false,
      items: ["guides/kickstart", "guides/existing-repo", "guides/tam-os"],
    },
    {
      type: "category",
      label: "reference",
      items: ["reference/api", "reference/cli", "reference/mcp", "reference/security"],
    },
  ],
};

export default sidebars;
