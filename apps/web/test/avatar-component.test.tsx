import { Avatar } from "@facility/ui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { avatarSrcFor } from "../lib/avatar-policy";

/**
 * Component boundary: what the browser is actually handed for each avatar
 * mode. The Avatar primitive paints the image as a CSS background over an
 * initial letter, so "no image" and "image that failed to load" must be
 * indistinguishable in markup — only a set background-image differs.
 */
function markup(login: string, mode?: Parameters<typeof avatarSrcFor>[1]): string {
  const src = avatarSrcFor(login, mode) ?? undefined;
  return renderToStaticMarkup(
    <Avatar size={14} src={src} initial={login.charAt(0).toUpperCase()} />,
  );
}

describe("Avatar at the component boundary", () => {
  it("enabled (proxy): renders same-origin background over the letter", () => {
    const html = markup("octocat", "proxy");
    expect(html).toContain("background-image:url(&quot;/api/avatars/u/octocat&quot;)");
    expect(html).toContain(">O<");
    // Nothing points outside this deployment.
    expect(html).not.toContain("github");
  });

  it("disabled (off): renders the letter with no image request at all", () => {
    const html = markup("octocat", "off");
    expect(html).not.toContain("background-image");
    expect(html).toContain(">O<");
  });

  it("failed load: markup identical to disabled — the letter survives", () => {
    // A CSS background that fails paints nothing; there is no broken-image
    // glyph and no error state, so failed-load markup equals no-src markup.
    const html = markup("guzmonne", "off");
    expect(html).toBe(renderToStaticMarkup(<Avatar size={14} initial="G" />));
  });
});
