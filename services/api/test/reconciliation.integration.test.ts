import { randomUUID } from "node:crypto";
import { createDb, migrate, reconciliationCursors } from "@facility/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { reconciliationPage } from "../src/reconciliation.js";

const url = process.env.DATABASE_URL ?? "postgres://facility:facility@localhost:5461/facility_test";
const { db, client } = createDb(url);
beforeAll(() => migrate(url));
afterAll(() => client.end());

it("serializes concurrent scan pages, wraps, and preserves progress on rollback", async () => {
  const name = `recovery-${randomUUID()}`;
  const records = ["a", "b", "c", "d", "e"].map((id) => ({ id }));
  const select = async (_tx: typeof db, after: string | null) =>
    records.filter((r) => !after || r.id > after).slice(0, 2);
  const pages = await Promise.all(
    Array.from({ length: 3 }, () => reconciliationPage(db, name, select)),
  );
  expect(
    pages
      .flat()
      .map((r) => r.id)
      .sort(),
  ).toEqual(["a", "b", "c", "d", "e"]);
  expect((await reconciliationPage(db, name, select)).map((r) => r.id)).toEqual(["a", "b"]);
  await expect(
    reconciliationPage(db, name, async () => {
      throw Error("scan failed");
    }),
  ).rejects.toThrow("scan failed");
  const [cursor] = await db
    .select()
    .from(reconciliationCursors)
    .where(eq(reconciliationCursors.name, name));
  expect(cursor?.lastId).toBe("b");
  expect((await reconciliationPage(db, name, select)).map((r) => r.id)).toEqual(["c", "d"]);
});
