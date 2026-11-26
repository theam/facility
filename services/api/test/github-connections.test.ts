import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openConnection, sealConnection, validatePrivateKey } from "../src/github/connections.js";
import { assertSameRepository } from "../src/github/rebind-repository.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const scope = { id: "ghc_a", orgId: "org_a", appId: 12 };
const key = Buffer.alloc(32, 12).toString("base64");
const secrets = { privateKey, webhookSecret: "a".repeat(40) };

describe("GitHub connection credentials", () => {
  it("encrypts secrets and binds them to connection, organization and App", async () => {
    const credentials = await sealConnection(scope, secrets, key);
    expect(credentials).not.toContain("PRIVATE KEY");
    expect(await openConnection({ ...scope, credentials }, key)).toEqual(secrets);
    for (const changed of [{ id: "ghc_b" }, { orgId: "org_b" }, { appId: 13 }]) {
      await expect(openConnection({ ...scope, ...changed, credentials }, key)).rejects.toThrow(
        "unavailable",
      );
    }
    await expect(
      openConnection({ ...scope, credentials }, Buffer.alloc(32, 13).toString("base64")),
    ).rejects.toThrow("unavailable");
    await expect(openConnection({ ...scope, credentials: "malformed" }, key)).rejects.toThrow(
      "unavailable",
    );
  });
  it("rejects malformed and non-RSA private keys without echoing their contents", () => {
    expect(() => validatePrivateKey("secret-invalid-key")).toThrow("valid RSA private key");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    expect(() => validatePrivateKey(ec)).toThrow("valid RSA private key");
  });
  it("requires a positive immutable identity match when preserving repository history", () => {
    expect(() => assertSameRepository(123, 123)).not.toThrow();
    for (const [before, after] of [
      [123, 456],
      [null, 123],
      [123, undefined],
      [-1, -1],
      [1.5, 1.5],
    ] as const)
      expect(() => assertSameRepository(before, after)).toThrow("same repository");
  });
});
