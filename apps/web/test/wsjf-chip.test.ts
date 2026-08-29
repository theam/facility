import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WsjfChip } from "@/components/issues/wsjf-chip";

const wsjf = { value: 8, time: 5, risk: 3, effort: 2, score: 8 };

describe("WSJF chip", () => {
  it("exposes the breakdown through a native disclosure, not a hover-only title", () => {
    const html = renderToStaticMarkup(createElement(WsjfChip, { wsjf }));
    // A details/summary pair is the interaction: the summary takes keyboard
    // focus and toggles on Enter, Space, or tap — no mouse hover required.
    expect(html).toMatch(/<details[^>]*><summary/);
    expect(html).toContain("wsjf 8");
    expect(html).toContain("value 8 · time 5 · risk 3 · effort 2");
    expect(html).not.toContain("title=");
  });

  it("names the control for assistive tech with the score it discloses", () => {
    const html = renderToStaticMarkup(createElement(WsjfChip, { wsjf }));
    expect(html).toContain('aria-label="WSJF score 8 — show breakdown"');
  });
});
