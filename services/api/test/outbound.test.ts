import { describe, expect, it } from "vitest";
import {
  isPublicAddress,
  nextAttempt,
  validateWebhookTarget,
} from "../src/integrations/outbound.js";

describe("outbound webhook target safety", () => {
  it("rejects private, reserved, and IPv4-mapped addresses in production", async () => {
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:127.0.0.1"]) {
      expect(isPublicAddress(address)).toBe(false);
      await expect(
        validateWebhookTarget("https://hooks.example/facility", false, async () => [
          { address, family: address.includes(":") ? 6 : 4 },
        ]),
      ).rejects.toThrow(/private or reserved/);
    }
  });

  it("accepts a public HTTPS address and retains the validated DNS answer", async () => {
    const result = await validateWebhookTarget(
      "https://hooks.example/facility",
      false,
      async () => [{ address: "8.8.8.8", family: 4 }],
    );
    expect(result.url.toString()).toBe("https://hooks.example/facility");
    expect(result.addresses).toEqual([{ address: "8.8.8.8", family: 4 }]);
  });

  it("honors numeric and HTTP-date Retry-After values with a 24 hour cap", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    expect(nextAttempt(now, 1, "90").toISOString()).toBe("2026-07-16T12:01:30.000Z");
    expect(nextAttempt(now, 1, "Thu, 16 Jul 2026 12:05:00 GMT").toISOString()).toBe(
      "2026-07-16T12:05:00.000Z",
    );
    expect(nextAttempt(now, 1, "Sat, 18 Jul 2026 12:00:00 GMT").toISOString()).toBe(
      "2026-07-17T12:00:00.000Z",
    );
  });
});
