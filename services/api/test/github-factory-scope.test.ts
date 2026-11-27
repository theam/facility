import type { FacilityDb } from "@facility/db";
import { expect, it, vi } from "vitest";
import {
  createGithubClientFactory,
  createGithubMaintainerTokenFactory,
} from "../src/github/client.js";
import { installationConfig } from "../src/github/connections.js";
import type { AppConfig } from "../src/types.js";

vi.mock("../src/github/connections.js", () => ({ installationConfig: vi.fn() }));

it("uses the caller's transaction for both GitHub factories and propagates denial without fallback", async () => {
  const db = {} as FacilityDb;
  const tx = {} as FacilityDb;
  const config = {} as AppConfig;
  const denied = new Error("GitHub connection is disabled");
  vi.mocked(installationConfig).mockRejectedValue(denied);
  const client = createGithubClientFactory(config, db);
  const token = createGithubMaintainerTokenFactory(config, db);
  await expect(client(123, 456, tx)).rejects.toBe(denied);
  expect(installationConfig).toHaveBeenLastCalledWith(tx, config, 123);
  await expect(token({ installationId: 123, repositoryIds: [456] }, tx)).rejects.toBe(denied);
  expect(installationConfig).toHaveBeenLastCalledWith(tx, config, 123);
  await expect(client(123)).rejects.toBe(denied);
  expect(installationConfig).toHaveBeenLastCalledWith(db, config, 123);
  await expect(token({ installationId: 123, repositoryIds: [456] })).rejects.toBe(denied);
  expect(installationConfig).toHaveBeenLastCalledWith(db, config, 123);
  expect(installationConfig).toHaveBeenCalledTimes(4);
});
