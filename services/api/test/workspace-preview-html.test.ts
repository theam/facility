import { describe, expect, it } from "vitest";
import { rewriteHtml } from "../src/routes/v1/workspace-previews.js";

const sessionId = "psess_abcdefghijklmnop";
const shimStart = "<script>(() => {";

describe("workspace preview HTML rewriting", () => {
  it("scopes root-relative attributes to the preview session", () => {
    const html = rewriteHtml(
      '<head></head><a href="/a"><img src=\'/b\'><a href="//cdn/x">',
      sessionId,
    );
    expect(html).toContain(`href="/workspace-preview/${sessionId}/a"`);
    expect(html).toContain(`src='/workspace-preview/${sessionId}/b'`);
    expect(html).toContain('href="//cdn/x"');
  });

  it("injects the request shim once, before any page script runs", () => {
    const head = rewriteHtml(
      '<!doctype html><html><head lang="en"><script>app()</script>',
      sessionId,
    );
    expect(head.indexOf(shimStart)).toBe(
      head.indexOf('<head lang="en">') + '<head lang="en">'.length,
    );
    expect(head.split(shimStart)).toHaveLength(2);

    const doctypeOnly = rewriteHtml("<!DOCTYPE html><script>app()</script>", sessionId);
    expect(doctypeOnly.startsWith(`<!DOCTYPE html>${shimStart}`)).toBe(true);

    const fragment = rewriteHtml("<header>x</header><script>app()</script>", sessionId);
    expect(fragment.startsWith(shimStart)).toBe(true);
  });

  it("keeps the session prefix a string literal inside the script", () => {
    const html = rewriteHtml("<head>", "</script><b>");
    expect(html).not.toContain("</script><b>");
    expect(html).toContain('"/workspace-preview/%3C%2Fscript%3E%3Cb%3E"');
  });
});
