import { describe, expect, it } from "vitest";
import { buildApp, mintSessionCookie } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

describe("signed-in UI rate limit", () => {
  it("gives each session its own budget and keeps anonymous callers on one address", async () => {
    const config: AppConfig = {
      databaseUrl,
      secretMasterKey: Buffer.alloc(32, 11).toString("base64"),
      port: 0,
      publicUrl: "http://127.0.0.1:4400",
      webUrl: "http://127.0.0.1:3400",
      workspaceImage: "facility-runner:test",
      workspaceDriver: "docker",
      facilityInsecureDev: false,
      logLevel: "silent",
    };
    const app = await buildApp(config, { rateLimitMax: 2 });
    const alice = encodeURIComponent(await mintSessionCookie(config, "user_alice", "org_test"));
    const bob = encodeURIComponent(await mintSessionCookie(config, "user_bob", "org_test"));

    const hit = (cookie?: string, forwardedFor?: string) =>
      app.inject({
        method: "GET",
        url: "/health",
        headers: {
          ...(cookie ? { cookie: `facility_session=${cookie}` } : {}),
          ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
        },
      });

    try {
      expect((await hit(alice)).statusCode).not.toBe(429);
      expect((await hit(alice)).statusCode).not.toBe(429);
      expect((await hit(alice)).statusCode).toBe(429);
      expect((await hit(bob)).statusCode).not.toBe(429);

      expect((await hit()).statusCode).not.toBe(429);
      expect((await hit()).statusCode).not.toBe(429);
      expect((await hit()).statusCode).toBe(429);
      expect((await hit("forged", "203.0.113.50")).statusCode).toBe(429);
    } finally {
      await app.close();
    }
  });
});
