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
      items: [
        "concepts/method",
        "concepts/the-loop",
        "concepts/stories-and-workspaces",
        "concepts/agents-as-code",
      ],
    },
    {
      type: "category",
      label: "self-hosting",
      collapsed: false,
      items: [
        "self-host/quickstart",
        "self-host/local-development",
        "self-host/production",
        "self-host/aws",
        "self-host/authentication",
        "self-host/github-app",
      ],
    },
    {
      type: "category",
      label: "guides",
      collapsed: false,
      items: [
        "guides/kickstart",
        "guides/existing-repo",
        "guides/operate-story",
        "guides/validate-workspace-loop",
        "guides/troubleshooting",
      ],
    },
    {
      type: "category",
      label: "reference",
      items: [
        "reference/architecture",
        "reference/project-manifest",
        "reference/agent-manifest",
        "reference/lifecycle",
        "reference/api",
        "reference/cli",
        "reference/mcp",
        "reference/webhooks",
        "reference/security",
        "reference/hardening",
        "reference/reference-fixture",
        "reference/upgrade-012",
      ],
    },
    {
      type: "category",
      label: "contributors",
      items: ["contributors/architecture", "contributors/testing", "contributors/documentation"],
    },
  ],
};

export default sidebars;
