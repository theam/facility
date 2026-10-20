import { defineConfig } from "vitest/config";

// Set this before importing @facility/db, whose migration entry loads .env.
const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://facility:facility@127.0.0.1:5461/facility_test";
if (!["facility_test", "facility_ws"].includes(new URL(databaseUrl).pathname.slice(1)))
  throw new Error("API tests require DATABASE_URL pointing to facility_test or facility_ws");

export default defineConfig({ test: { env: { DATABASE_URL: databaseUrl } } });
