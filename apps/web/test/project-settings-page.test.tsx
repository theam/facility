// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ProjectSettingsPage from "../app/(app)/projects/[projectId]/settings/page";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("../lib/api", () => ({
  api: {
    project: async () => ({ ok: true, data: { id: "project", name: "Atlas", settings: {} } }),
    projectRepos: async () => ({ ok: true, data: [] }),
    me: async () => ({ ok: true, data: { permissions: ["projects:read"] } }),
    projectWorkflowPolicy: async () => ({ ok: false, message: "Policy unavailable" }),
    storyAgents: async () => ({ ok: true, data: { agents: [] } }),
  },
}));
describe("project settings entry", () => {
  it("keeps configuration destinations and scope visible when one policy read fails", async () => {
    const root = document.createElement("div");
    root.innerHTML = renderToStaticMarkup(
      await ProjectSettingsPage({ params: Promise.resolve({ projectId: "project" }) }),
    );
    expect(root.textContent).toContain("Project settings");
    expect(root.querySelector("h1")?.textContent).toBe("Atlas");
    expect(
      [...root.querySelectorAll('nav[aria-label="Project configuration"] a')].map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Agents and skills", "/projects/project/agents"],
      ["Workflow policy", "#workflow-policy"],
      ["Repositories", "#repositories"],
      ["Budget and usage", "/projects/project/insights"],
    ]);
    expect(root.querySelector("#workflow-policy")?.textContent).toContain("Policy unavailable");
    expect(root.querySelector("#repositories")).not.toBeNull();
    expect(root.textContent).not.toContain("Save policy");
  });
});
