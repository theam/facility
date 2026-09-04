import { describe, expect, it } from "vitest";
import { generateApiKey, keyLookup, open, seal, verifyKey } from "../src/crypto.js";
import { diffManifest, manifestFor } from "../src/fingerprints.js";
import { newId } from "../src/ids.js";
import { can, PermissionSchema } from "../src/permissions.js";
import { BUNDLED_ROLES } from "../src/roles.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");

describe("Facility 0.12 core", () => {
  it("creates typed UUIDv7 identifiers", () => {
    expect(newId("proj")).toMatch(/^proj_[0-9a-f]{32}$/);
    expect(newId("story")).toMatch(/^story_[0-9a-f]{32}$/);
    expect(newId("ws")).toMatch(/^ws_[0-9a-f]{32}$/);
    expect(newId("turn")).toMatch(/^turn_[0-9a-f]{32}$/);
  });

  it("hashes and verifies API keys without storing their secret", async () => {
    const key = await generateApiKey("fak");
    expect(keyLookup(key.secret)).toBe(key.lookup);
    await expect(verifyKey(key.secret, key.hash)).resolves.toBe(true);
    await expect(verifyKey(`${key.secret}x`, key.hash)).resolves.toBe(false);
  });

  it("encrypts persisted OAuth and session values and rejects tampering", async () => {
    const sealed = await seal("private", masterKey);
    await expect(open(sealed, masterKey)).resolves.toBe("private");
    const replacement = sealed.endsWith("A") ? "B" : "A";
    await expect(open(`${sealed.slice(0, -1)}${replacement}`, masterKey)).rejects.toThrow();
  });

  it("keeps owner and maintainer full access while viewer stays read-only", () => {
    const roles = new Map(BUNDLED_ROLES.map((role) => [role.name, role.permissions]));
    expect(can(roles.get("owner") ?? [], "workspaces:execute")).toBe(true);
    expect(can(roles.get("maintainer") ?? [], "projects:write")).toBe(true);
    expect(can(roles.get("viewer") ?? [], "stories:read")).toBe(true);
    expect(can(roles.get("viewer") ?? [], "stories:write")).toBe(false);
    expect(PermissionSchema.safeParse("workspaces:execute").success).toBe(true);
    expect(PermissionSchema.safeParse("receipts:write").success).toBe(false);
  });

  it("produces deterministic kickstart manifests and reports drift", () => {
    const expected = manifestFor([
      { path: ".facility.yml", content: "version: 1\n" },
      { path: ".agents/builder.md", content: "builder\n" },
    ]);
    const same = manifestFor([
      { path: ".agents/builder.md", content: "builder\n" },
      { path: ".facility.yml", content: "version: 1\n" },
    ]);
    expect(same).toEqual(expected);
    expect(
      diffManifest(expected, manifestFor([{ path: ".facility.yml", content: "version: 2\n" }])),
    ).toEqual({
      missing: [".agents/builder.md"],
      modified: [".facility.yml"],
      extra: [],
    });
  });
});
