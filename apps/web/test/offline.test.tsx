import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { Offline } from "../components/offline";

afterEach(() => vi.unstubAllEnvs());

it("shows a local source checkout how to start the API", () => {
  vi.stubEnv("NODE_ENV", "development");
  const html = renderToStaticMarkup(<Offline detail="fetch failed" />);
  expect(html).toContain("did not answer (fetch failed).");
  expect(html).toContain("pnpm --filter @facility/api dev");
});

it("gives production users guidance they can act on instead of a dev command", () => {
  vi.stubEnv("NODE_ENV", "production");
  const html = renderToStaticMarkup(<Offline detail="fetch failed" />);
  expect(html).toContain("reach its API right now (fetch failed).");
  expect(html).toContain("If the problem continues, contact your Facility administrator.");
  expect(html).not.toContain("pnpm");
});
