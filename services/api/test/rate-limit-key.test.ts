import { seal } from "@facility/core";
import { describe, expect, it } from "vitest";
import { rateLimitKey } from "../src/rate-limit-key.js";

const masterKey = Buffer.alloc(32, 9).toString("base64");

async function session(userId: string, exp = Date.now() + 60_000) {
  return seal(JSON.stringify({ userId, orgId: "org_test", exp }), masterKey);
}

describe("UI rate limit keys", () => {
  it("gives each verified session its own bucket", async () => {
    const first = await session("user_one");
    const second = await session("user_two");
    await expect(
      rateLimitKey({ ip: "10.0.0.8", cookieHeader: `facility_session=${first}` }, masterKey),
    ).resolves.toBe("session:user_one");
    await expect(
      rateLimitKey(
        { ip: "10.0.0.8", cookieHeader: `other=1; facility_session=${encodeURIComponent(second)}` },
        masterKey,
      ),
    ).resolves.toBe("session:user_two");
  });

  it("keeps missing, forged, and expired cookies on the shared address", async () => {
    const expired = await session("user_old", Date.now() - 1_000);
    await expect(
      rateLimitKey({ ip: "10.0.0.8", cookieHeader: undefined }, masterKey),
    ).resolves.toBe("10.0.0.8");
    await expect(
      rateLimitKey({ ip: "10.0.0.8", cookieHeader: "facility_session=forged" }, masterKey),
    ).resolves.toBe("10.0.0.8");
    await expect(
      rateLimitKey({ ip: "10.0.0.8", cookieHeader: `facility_session=${expired}` }, masterKey),
    ).resolves.toBe("10.0.0.8");
  });
});
