import { createServer } from "node:net";
import { migrate, seed } from "@facility/db";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/types.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";

async function canConnect() {
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end().catch(() => undefined);
  }
}

async function unusedPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

describe("loopback-only local development login", async () => {
  const reachable = await canConnect();
  if (!reachable) {
    const databaseExpectation = process.env.CI ? it : it.skip;
    databaseExpectation("Postgres is reachable at DATABASE_URL", () =>
      expect(reachable).toBe(true),
    );
    return;
  }

  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

  beforeAll(async () => {
    await migrate(databaseUrl);
    await seed(databaseUrl, { includeDemoData: true });
  });

  afterAll(async () => {
    await Promise.all(apps.map((app) => app.close()));
  });

  async function appFor(insecure: boolean) {
    const port = await unusedPort();
    const config: AppConfig = {
      databaseUrl,
      secretMasterKey: Buffer.alloc(32, insecure ? 21 : 22).toString("base64"),
      port,
      publicUrl: `http://127.0.0.1:${port}`,
      webUrl: `http://127.0.0.1:${port}`,
      workspaceImage: "facility-runner:dev",
      workspaceDriver: "docker",
      facilityInsecureDev: insecure,
      logLevel: "silent",
    };
    const app = await buildApp(config, { rateLimitMax: 10_000 });
    apps.push(app);
    return app;
  }

  it("creates an owner session only when insecure local development is enabled", async () => {
    const app = await appFor(true);
    const login = await app.inject({ method: "GET", url: "/auth/dev-login" });

    expect(login.statusCode).toBe(302);
    expect(login.headers.location).toMatch(/^http:\/\/127\.0\.0\.1:/);
    const cookie = login.cookies.find((item) => item.name === "facility_session");
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie?.secure).not.toBe(true);

    const me = await app.inject({
      method: "GET",
      url: "/v1/me",
      headers: { cookie: `${cookie?.name}=${cookie?.value}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      principal: { email: "admin@facility.local" },
      org: { slug: "facility-local" },
    });
  });

  it("does not register the shortcut when local development login is disabled", async () => {
    const app = await appFor(false);
    const response = await app.inject({ method: "GET", url: "/auth/dev-login" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "not_found", message: "Route not found" },
    });
  });
});
