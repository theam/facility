import { expect, it } from "vitest";
import { safeRequestLog } from "../src/request-log.js";

it("omits callback codes, launch grants and browser credentials from access logs", () => {
  for (const path of ["/callback?code=secret", "/.facility/auth/psess_test?token=secret"]) {
    const result = safeRequestLog({
      method: "GET",
      url: path,
      headers: { cookie: "secret" },
    } as Parameters<typeof safeRequestLog>[0]);
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.url).toBe(path.split("?", 1)[0]);
  }
});
