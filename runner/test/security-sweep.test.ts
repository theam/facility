import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  prepareSecuritySweepEvidence,
  verifySecuritySweepEvidence,
} from "../src/security-sweep.js";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const HEAD_SHA = "a".repeat(40);
const expected = {
  runId: "run_security",
  owner: "acme",
  repo: "widget",
  ref: "main",
  headSha: HEAD_SHA,
};

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    schema: "facility.security.sweep-input.v1",
    runId: expected.runId,
    collectedAt: NOW.toISOString(),
    repository: {
      owner: expected.owner,
      name: expected.repo,
      ref: expected.ref,
      headSha: expected.headSha,
    },
    sources: {
      codeScanning: [],
      dependabot: [],
      secretScanning: {
        unavailable: true,
        source: "secret-scanning",
        reason: "endpoint_unavailable",
      },
      sbom: { sbom: { packages: [] } },
    },
    ...overrides,
  };
}

const local = {
  workflowPermissions: "ci.yml:4:permissions:\n",
  guards: { ok: true, findings: [] },
  weekDiff: "abc123 fix: harden input\nsrc/input.ts\n",
};

describe("platform security-sweep evidence", () => {
  it("materializes run-bound evidence and detects post-collection tampering", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "facility-sweep-"));
    try {
      const prepared = await prepareSecuritySweepEvidence({
        cwd,
        raw: evidence(),
        expected,
        local,
        now: NOW,
      });

      await expect(verifySecuritySweepEvidence(prepared)).resolves.toBe(true);
      await expect(
        readFile(join(cwd, ".facility-sweep", "code-scanning.json"), "utf8"),
      ).resolves.toBe("[]\n");
      const manifest = JSON.parse(
        await readFile(join(cwd, ".facility-sweep", "manifest.json"), "utf8"),
      );
      expect(manifest).toMatchObject({
        schema: "facility.security.sweep.v1",
        run_id: expected.runId,
        repository: { head_sha: HEAD_SHA },
      });
      expect(manifest.files).toMatchObject({
        "code-scanning.json": expect.stringMatching(/^[0-9a-f]{64}$/),
        "guards.json": expect.stringMatching(/^[0-9a-f]{64}$/),
      });

      await writeFile(join(cwd, ".facility-sweep", "dependabot.json"), '[{"injected":true}]\n');
      await expect(verifySecuritySweepEvidence(prepared)).resolves.toBe(false);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("accepts API-bounded compact JSON that would exceed the cap when pretty-printed", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "facility-sweep-compact-"));
    const alerts = Array.from({ length: 1_000 }, (_, number) => ({
      number,
      detail: "x".repeat(220),
    }));
    expect(Buffer.byteLength(JSON.stringify(alerts))).toBeLessThan(256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(alerts, null, 2))).toBeGreaterThan(256 * 1024);
    try {
      const current = evidence();
      const prepared = await prepareSecuritySweepEvidence({
        cwd,
        raw: evidence({
          sources: { ...(current.sources as Record<string, unknown>), codeScanning: alerts },
        }),
        expected,
        local,
        now: NOW,
      });

      await expect(verifySecuritySweepEvidence(prepared)).resolves.toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", null],
    ["malformed source", evidence({ sources: { codeScanning: {} } })],
    ["cross-run", evidence({ runId: "run_other" })],
    ["cross-repository", evidence({ repository: { ...evidence().repository, name: "other" } })],
    ["cross-ref", evidence({ repository: { ...evidence().repository, ref: "release" } })],
    ["cross-head", evidence({ repository: { ...evidence().repository, headSha: "b".repeat(40) } })],
    ["stale", evidence({ collectedAt: "2026-08-07T08:59:59.000Z" })],
  ])("rejects %s evidence before the agent runs", async (_case, raw) => {
    const cwd = await mkdtemp(join(tmpdir(), "facility-sweep-invalid-"));
    try {
      await expect(
        prepareSecuritySweepEvidence({ cwd, raw, expected, local, now: NOW }),
      ).rejects.toThrow(/security_sweep_evidence/);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("refuses to replace repository-owned evidence", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "facility-sweep-existing-"));
    try {
      await mkdir(join(cwd, ".facility-sweep"));
      await expect(
        prepareSecuritySweepEvidence({ cwd, raw: evidence(), expected, local, now: NOW }),
      ).rejects.toThrow("security_sweep_directory_already_exists");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
