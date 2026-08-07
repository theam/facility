import { describe, expect, it } from "vitest";
import { sandboxCachePartition, sandboxNamespace } from "../src/sandbox/cache.js";

const firstKey = Buffer.alloc(32, 1).toString("base64");
const secondKey = Buffer.alloc(32, 2).toString("base64");

describe("sandbox cache partition", () => {
  it("is stable only inside one master-key, organization, and project boundary", () => {
    const partition = sandboxCachePartition(firstKey, "org_alpha", "proj_one");

    expect(partition).toMatch(/^[a-f0-9]{64}$/);
    expect(sandboxCachePartition(firstKey, "org_alpha", "proj_one")).toBe(partition);
    expect(sandboxCachePartition(firstKey, "org_beta", "proj_one")).not.toBe(partition);
    expect(sandboxCachePartition(firstKey, "org_alpha", "proj_two")).not.toBe(partition);
    expect(sandboxCachePartition(secondKey, "org_alpha", "proj_one")).not.toBe(partition);
  });

  it("uses unambiguous domain-separated input without exposing tenant ids", () => {
    const left = sandboxCachePartition(firstKey, "a", "bc");
    const right = sandboxCachePartition(firstKey, "ab", "c");
    const orgId = "org_PUBLIC-TENANT-ALPHA";
    const projectId = "proj_PUBLIC-PROJECT-ONE";
    const opaque = sandboxCachePartition(firstKey, orgId, projectId);

    expect(left).not.toBe(right);
    expect(opaque).not.toContain(orgId);
    expect(opaque).not.toContain(projectId);
  });
});

describe("sandbox namespace", () => {
  it("is stable across password rotation but distinct across local databases", () => {
    const base = {
      secretMasterKey: firstKey,
      databaseUrl: "postgres://facility:first@postgres:5432/facility_a",
    };
    const namespace = sandboxNamespace(base);

    expect(namespace).toMatch(/^[a-f0-9]{32}$/);
    expect(
      sandboxNamespace({
        ...base,
        databaseUrl: "postgres://facility:rotated@postgres:5432/facility_a",
      }),
    ).toBe(namespace);
    expect(
      sandboxNamespace({
        ...base,
        databaseUrl: "postgres://facility:first@postgres:5432/facility_b",
      }),
    ).not.toBe(namespace);
    expect(sandboxNamespace({ ...base, secretMasterKey: secondKey })).not.toBe(namespace);
  });

  it("uses an explicit instance id as the stable deployment identity", () => {
    const first = sandboxNamespace({
      secretMasterKey: firstKey,
      databaseUrl: "postgres://facility:first@old-postgres:5432/facility",
      facilityInstanceId: "facility-production",
    });
    const moved = sandboxNamespace({
      secretMasterKey: secondKey,
      databaseUrl: "postgres://facility:second@new-postgres:6432/facility_moved",
      facilityInstanceId: "facility-production",
    });
    const other = sandboxNamespace({
      secretMasterKey: firstKey,
      databaseUrl: "postgres://facility:first@old-postgres:5432/facility",
      facilityInstanceId: "facility-staging",
    });

    expect(moved).toBe(first);
    expect(other).not.toBe(first);
    expect(first).not.toContain("facility-production");
  });
});
