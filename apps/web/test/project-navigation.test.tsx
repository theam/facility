// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "../components/shell/nav";

const navigation = vi.hoisted(() => ({ pathname: "/projects/project" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname }));

function render(path: string, project = { id: "project", slug: "atlas", name: "Atlas" }) {
  navigation.pathname = path;
  const root = document.createElement("div");
  root.innerHTML = renderToStaticMarkup(<Sidebar project={project} />);
  return root;
}
describe("project navigation", () => {
  it("keeps Attention and Stories primary, with project tools and settings one step away", () => {
    const root = render("/projects/project");
    expect(
      [...root.querySelectorAll('nav[aria-label="Primary"] a')].map((a) => a.textContent),
    ).toEqual(["Attention", "Stories"]);
    expect(
      [...root.querySelectorAll('nav[aria-label="Project tools"] a')].map((a) => [
        a.textContent,
        a.getAttribute("href"),
      ]),
    ).toEqual([
      ["Activity", "/projects/project/activity"],
      ["Insights", "/projects/project/insights"],
      ["Settings", "/projects/project/settings"],
    ]);
    expect(root.textContent).toContain("Atlas");
    expect(root.querySelector('a[href="/projects"]')?.textContent).toContain(
      "Back to all projects",
    );
  });
  it("marks one section for deep links without claiming a different project's path", () => {
    for (const [path, label] of [
      ["", "Attention"],
      ["/attention", "Attention"],
      ["/attention/review", "Attention"],
      ["/stories/story/plan/decisions/request", "Stories"],
      ["/activity", "Activity"],
      ["/agents", "Settings"],
      ["/settings", "Settings"],
    ]) {
      const root = render(`/projects/project${path}`);
      expect([...root.querySelectorAll('[aria-current="page"]')].map((a) => a.textContent)).toEqual(
        [label],
      );
    }
    expect(render("/projects/project-other").querySelector('[aria-current="page"]')).toBeNull();
    expect(
      render("/projects/project/attention-other").querySelector('[aria-current="page"]'),
    ).toBeNull();
    const escaped = render("/projects/a%2Fb", { id: "a/b", slug: "a", name: "Escaped project" });
    expect(escaped.querySelector('[aria-current="page"]')?.getAttribute("href")).toBe(
      "/projects/a%2Fb",
    );
  });
});
