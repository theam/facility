import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "@/components/markdown";

const MARK = "\uE000";

function render(source: string): string {
  return renderToStaticMarkup(createElement(Markdown, { source }));
}

describe("Markdown inline parsing", () => {
  it("keeps emphasis intact when it wraps code spans", () => {
    // Agent-written plans are full of this shape. Splitting code spans out
    // before emphasis used to strand the ** markers and leak them as literal
    // asterisks on every bullet of a plan_acceptance gate.
    const html = render(
      "- **Reuse the existing `dateOfBirth`/`ageOn` pattern for `expiresOn`.** `intake.js:16-20` validates it.",
    );
    expect(html).not.toContain("**");
    expect(html).toContain("<strong");
    expect(html).toContain("dateOfBirth");
    expect(html).toContain("expiresOn");
    expect(html.match(/<code/g)).toHaveLength(4);
  });

  it("leaves asterisks inside a code span literal", () => {
    const html = render("Use `a ** b` in the formula.");
    expect(html).toContain("a ** b");
    expect(html).not.toContain("<strong");
  });

  it("renders italics that wrap code", () => {
    const html = render("*see `intake.js` first*");
    expect(html).toContain("<em");
    expect(html).toContain("<code");
    expect(html).not.toContain("*");
  });

  it("renders code inside a link label", () => {
    const html = render("[the `intake` module](https://example.com/x)");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain("<code");
  });

  it("renders bold and code together inside a table cell", () => {
    const html = render("| a | b |\n| --- | --- |\n| **x `y`** | z |");
    expect(html).toContain("<table");
    expect(html).toContain("<strong");
    expect(html).toContain("<code");
  });

  it("still emphasises documents that contain no code spans", () => {
    const html = render("**just bold** and *just italic*");
    expect(html).toContain("<strong");
    expect(html).toContain("<em");
    expect(html).not.toContain("*");
  });

  it("cannot be tricked by a placeholder forged in the source", () => {
    // MARK is the internal code-span marker; source text must never reach the
    // restore pass carrying one.
    const html = render(`literal ${MARK}c0${MARK} marker plus a real \`span\``);
    expect(html).not.toContain(MARK);
    expect(html).toContain("c0");
    expect(html).toContain("<code");
    expect(html).toContain("span");
  });

  it("renders headings, task items, and quotes", () => {
    expect(render("## Goal and scope")).toContain("<h2");
    expect(render("- [x] ship `expiresOn`")).toContain("line-through");
    expect(render("> a caveat")).toContain("<blockquote");
  });

  it("flows hard-wrapped prose into one paragraph", () => {
    const html =
      render(`Binding contract for the weekly security audit agent. A deterministic job has
collected the repo's security context when scanners are available; your job is
to audit it with judgment.

The next paragraph remains separate.`);
    expect(html.match(/<p/g)).toHaveLength(2);
    expect(html).toContain(
      "A deterministic job has collected the repo&#x27;s security context when scanners are available",
    );
  });

  it("keeps wrapped continuation lines inside list items and contract tags separate", () => {
    const html = render(`1. Correlate the collected alerts with the actual code: is the vulnerable
   path reachable? Kill noise; keep signal.
2. Sweep the deltas of the last week for new
   attack surface.
</what_to_audit>`);
    expect(html.match(/<li/g)).toHaveLength(2);
    expect(html).toContain("vulnerable path reachable");
    expect(html).toContain('translate="no"');
    expect(html).toContain("&lt;/what_to_audit&gt;");
  });
});
