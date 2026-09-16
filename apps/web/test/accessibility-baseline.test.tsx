import { VisuallyHidden } from "@facility/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import LoginPage, { metadata as loginMetadata } from "../app/login/page";
import { MAIN_CONTENT_ID, SkipLink } from "../components/shell/skip-link";

describe("accessibility baseline", () => {
  it("provides a reusable visually hidden primitive", () => {
    const html = renderToStaticMarkup(<VisuallyHidden>Additional context</VisuallyHidden>);

    expect(html).toBe('<span class="sr-only">Additional context</span>');
  });

  it("renders a skip link to the shared main-content target", () => {
    const html = renderToStaticMarkup(<SkipLink />);

    expect(html).toContain(`href="#${MAIN_CONTENT_ID}"`);
    expect(html).toContain("Skip to main content");
  });

  it("gives the login page a main landmark, heading, and descriptive title", () => {
    const html = renderToStaticMarkup(<LoginPage />);

    expect(html.match(/<main/g) ?? []).toHaveLength(1);
    expect(html).toContain("<h1");
    expect(html).toContain('<span class="sr-only"> sign in</span>');
    expect(loginMetadata).toEqual({ title: "Sign in" });
  });
});
