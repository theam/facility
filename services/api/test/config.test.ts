import { describe, expect, it } from "vitest";
import { readConfig } from "../src/config.js";

const validEnv = {
  DATABASE_URL: "postgres://facility:facility@localhost:5432/facility",
  SECRET_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
};

describe("API configuration", () => {
  it("accepts a master key that decodes to exactly 32 bytes", () => {
    expect(readConfig(validEnv).secretMasterKey).toBe(validEnv.SECRET_MASTER_KEY);
  });

  it("fails at startup for a malformed master key", () => {
    expect(() => readConfig({ ...validEnv, SECRET_MASTER_KEY: "not-a-32-byte-key" })).toThrow(
      "SECRET_MASTER_KEY must be base64 that decodes to exactly 32 bytes",
    );
  });

  it("rejects malformed base64 even when Node can permissively decode 32 bytes", () => {
    expect(() =>
      readConfig({ ...validEnv, SECRET_MASTER_KEY: `${validEnv.SECRET_MASTER_KEY}!` }),
    ).toThrow("SECRET_MASTER_KEY must be base64 that decodes to exactly 32 bytes");
  });

  it("refuses insecure development login in production", () => {
    expect(() =>
      readConfig({ ...validEnv, NODE_ENV: "production", FACILITY_INSECURE_DEV: "1" }),
    ).toThrow("FACILITY_INSECURE_DEV is refused in production");
  });
});
