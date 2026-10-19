import { VisuallyHidden } from "@facility/ui";
import type { ReactElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import OrgLayout from "@/app/(app)/(org)/layout";
import ProjectLayout from "@/app/(app)/projects/[projectId]/layout";
import LoginPage, { metadata as loginMetadata } from "@/app/login/page";
import { SkipLink } from "@/components/shell/skip-link";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: () => {
    throw new Error("redirect");
  },
  usePathname: () => "/",
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock("@/lib/api", () => ({
  api: {
    me: async () => ({ ok: true, data: {} }),
    projects: async () => ({ ok: true, data: [] }),
    project: async () => ({ ok: true, data: { id: "p_1", slug: "acme", name: "Acme" } }),
  },
}));
vi.mock("@/components/shell/topbar", () => ({ Topbar: () => null }));
vi.mock("@/components/shell/remember-project", () => ({ RememberProject: () => null }));

function render(element: ReactElement) {
  return renderToString(element);
}

describe("skip link", () => {
  it("targets the main content and is keyboard-only visible", () => {
    const html = render(<SkipLink />);
    expect(html).toContain('href="#main-content"');
    expect(html).toContain("Skip to main content");
    expect(html).toContain("sr-only");
    expect(html).toContain("focus:not-sr-only");
  });

  it("precedes the sidebar and lands on a focusable main in the org shell", async () => {
    const html = render(await OrgLayout({ children: <p>dashboard</p> }));
    const skip = html.indexOf("Skip to main content");
    const sidebar = html.indexOf('aria-label="Primary"');
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(sidebar);
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
  });

  it("holds for the project shell too", async () => {
    const html = render(
      await ProjectLayout({
        children: <p>overview</p>,
        params: Promise.resolve({ projectId: "p_1" }),
      }),
    );
    const skip = html.indexOf("Skip to main content");
    const sidebar = html.indexOf('aria-label="Primary"');
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(skip).toBeLessThan(sidebar);
    expect(html).toContain('id="main-content"');
    expect(html).toContain('tabindex="-1"');
  });
});

describe("visually hidden text", () => {
  it("names icon-only controls without removing content from the tree", () => {
    const html = render(
      <button type="button">
        <svg aria-hidden viewBox="0 0 16 16" />
        <VisuallyHidden>Delete story</VisuallyHidden>
      </button>,
    );
    expect(html).toContain("Delete story");
    expect(html).toContain("sr-only");
    expect(html).not.toContain("display:none");
  });
});

describe("login page landmarks", () => {
  it("exposes a main landmark, a heading, and a descriptive title", () => {
    const html = render(<LoginPage />);
    expect(html).toContain("<main");
    expect(html).toContain("<h1");
    expect(loginMetadata.title).toBe("Sign in");
  });
});
