// @vitest-environment jsdom
import { readdirSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OrgLayout from "../app/(app)/(org)/layout";
import ProjectLayout from "../app/(app)/projects/[projectId]/layout";
import { CommandPalette } from "../components/shell/cmdk";

const push = vi.hoisted(() => vi.fn());
vi.mock("../lib/last-project", () => ({
  rememberLastProject: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/projects",
}));
vi.mock("../lib/api", () => ({
  api: {
    me: async () => ({ ok: false }),
    project: async () => ({ ok: true, data: projects[0] }),
    projects: async () => ({ ok: true, data: projects }),
  },
}));

const projects = [
  { id: "project-a", slug: "alpha", name: "Alpha" },
  { id: "project-b", slug: "beta", name: "Beta" },
];
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  push.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function key(target: EventTarget, value: string, ctrlKey = false) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key: value, ctrlKey, bubbles: true }));
  });
}

async function open(currentProject = projects[0]) {
  await act(async () =>
    root.render(<CommandPalette projects={projects} currentProject={currentProject} />),
  );
  await key(document, "k", true);
}

async function search(value: string) {
  const input = container.querySelector("input");
  if (!input) throw new Error("Command palette input is missing");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

describe("command palette destinations", () => {
  it("mounts the keyboard palette in the project shell", async () => {
    const shell = await ProjectLayout({
      children: null,
      params: Promise.resolve({ projectId: "project-a" }),
    });
    await act(async () => root.render(shell));
    await key(document, "k", true);
    expect(container.querySelector("[role='dialog']")?.textContent).toContain("alpha · stories");
  });

  it("mounts the keyboard palette in the organization shell", async () => {
    const shell = await OrgLayout({ children: null });
    await act(async () => root.render(shell));
    await key(document, "k", true);
    expect(container.querySelector("[role='dialog']")?.textContent).toContain("org settings");
  });

  it("offers the current project sections and navigates to real application pages", async () => {
    const routes = readdirSync("app", { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith("/page.tsx"))
      .map((file) => `/${file.replace(/\([^/]+\)\//g, "").replace(/\/page\.tsx$/, "")}`);
    await open();
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    for (const section of ["overview", "stories", "pipeline", "insights", "agents", "settings"]) {
      expect(labels.some((label) => label?.includes(`alpha · ${section}`))).toBe(true);
    }
    for (let index = 0; index < labels.length; index += 1) {
      if (index > 0) await key(document, "k", true);
      const button = container.querySelectorAll("button")[index];
      if (!button) throw new Error(`Command palette entry ${index} is missing`);
      await act(async () => button.click());
      const href = push.mock.lastCall?.[0] as string;
      const route = href.replace(/\/projects\/project-[ab](?=\/|$)/, "/projects/[projectId]");
      expect(routes, href).toContain(route);
    }
  });

  it("supports filtering and keyboard selection of current project sections", async () => {
    await open();
    const input = await search("alpha ·");
    await key(input, "ArrowDown");
    await key(input, "ArrowDown");
    await key(input, "Enter");
    expect(push).toHaveBeenLastCalledWith("/projects/project-a/pipeline");
    expect(container.querySelector("[role='dialog']")).toBeNull();
  });

  it("updates project-scoped destinations when switching projects", async () => {
    await open(projects[1]);
    const input = await search("beta · agents");
    await key(input, "Enter");
    expect(push).toHaveBeenLastCalledWith("/projects/project-b/agents");
    await key(document, "k", true);
    const projectInput = await search("alpha");
    await key(projectInput, "Enter");
    expect(push).toHaveBeenLastCalledWith("/projects/project-a");
  });

  it("keeps organization navigation available without an active project", async () => {
    await act(async () => root.render(<CommandPalette projects={projects} />));
    await key(document, "k", true);
    const labels = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(labels).toEqual([
      "projectsorg",
      "org settingsorg",
      "kickstart a projectorg",
      "alphaswitch project",
      "betaswitch project",
    ]);
    const input = await search("org settings");
    await key(input, "Enter");
    expect(push).toHaveBeenLastCalledWith("/settings");
  });
});
