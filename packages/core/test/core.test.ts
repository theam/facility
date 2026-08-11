import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { hashChain } from "../src/audit.js";
import {
  generateApiKey,
  hashKey,
  mintConfirmation,
  open,
  seal,
  verifyConfirmation,
  verifyKey,
} from "../src/crypto.js";
import { diffManifest, manifestFor } from "../src/fingerprints.js";
import { newId } from "../src/ids.js";
import { allowedModelsForEngine, CLAUDE_CODE_MODEL_POLICY_VERSION } from "../src/models.js";
import { can } from "../src/permissions.js";
import { costCents } from "../src/pricing.js";
import { normalizeClaudeCodeOAuthToken } from "../src/provider-auth.js";
import { validateProviderBaseUrl } from "../src/provider-url.js";
import {
  parseLegacyAgentReceipt,
  receiptContentDigest,
  sealFacilityReceipt,
  verifyFacilityReceipt,
} from "../src/receipts.js";
import { renderFacilityInit } from "../src/render.js";

const masterKey = Buffer.alloc(32, 7).toString("base64");

describe("Claude Code OAuth token normalization", () => {
  const token = "sk-ant-oat01-abcdefghijklmnopqrstuvwxyz";

  it.each([
    token,
    `  ${token}\n`,
    `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    `export CLAUDE_CODE_OAUTH_TOKEN="${token}"`,
    `export CLAUDE_CODE_OAUTH_TOKEN='${token}'`,
  ])("accepts setup-token output without changing the bearer value", (input) => {
    expect(normalizeClaudeCodeOAuthToken(input)).toBe(token);
  });

  it.each([
    "",
    "short",
    `${token}\nsecond-line`,
    `${token} injected`,
    `export OTHER=${token}`,
  ])("rejects malformed or header-breaking input", (input) => {
    expect(normalizeClaudeCodeOAuthToken(input)).toBeNull();
  });
});

describe("run-scoped model policy", () => {
  it("expands Claude Code's hybrid model into its concrete wire models", () => {
    expect(allowedModelsForEngine("claude_code", { model: "opusplan" })).toEqual([
      "claude-opus-4-8",
      "claude-sonnet-5",
    ]);
  });

  it("matches every alias emitted by Claude Code 2.1.215 through a custom base URL", () => {
    expect(allowedModelsForEngine("claude_code", { model: "opus" })).toEqual(["claude-opus-4-8"]);
    expect(allowedModelsForEngine("claude_code", { model: "opus48" })).toEqual(["opus48"]);
    expect(allowedModelsForEngine("claude_code", { model: "sonnet" })).toEqual(["claude-sonnet-5"]);
    expect(allowedModelsForEngine("claude_code", { model: "sonnet46" })).toEqual(["sonnet46"]);
    expect(allowedModelsForEngine("claude_code", { model: "haiku" })).toEqual([
      "claude-haiku-4-5-20251001",
    ]);
    expect(allowedModelsForEngine("claude_code", { model: "haiku45" })).toEqual(["haiku45"]);
    expect(allowedModelsForEngine("claude_code", { model: "fable" })).toEqual(["claude-fable-5"]);
    expect(allowedModelsForEngine("claude_code", { model: "fable5" })).toEqual(["fable5"]);
  });

  it("restricts Codex primary models and preserves exact model ids", () => {
    expect(allowedModelsForEngine("codex", { primary: "gpt-5.6-sol" })).toEqual(["gpt-5.6-sol"]);
    expect(allowedModelsForEngine("claude_code", { model: "claude-fable-5" })).toEqual([
      "claude-fable-5",
    ]);
    expect(allowedModelsForEngine("claude_code", { model: "future-alias" })).toEqual([
      "future-alias",
    ]);
  });

  it("leaves BYO routing unrestricted even when its command has model metadata", () => {
    expect(
      allowedModelsForEngine("byo", { model: "metadata-model", primary: "metadata-primary" }),
    ).toBeUndefined();
  });

  it("fails CI when the pinned Claude Code version changes without reviewing its alias map", () => {
    const agentClis = JSON.parse(
      readFileSync(new URL("../../../runner/agent-clis/package.json", import.meta.url), "utf8"),
    );
    expect(agentClis.dependencies["@anthropic-ai/claude-code"]).toBe(
      CLAUDE_CODE_MODEL_POLICY_VERSION,
    );
  });
});

describe("ids", () => {
  it("creates prefixed uuidv7 ids", () => {
    expect(newId("proj")).toMatch(/^proj_[0-9a-f]{32}$/);
    expect(newId("pvh")).toMatch(/^pvh_[0-9a-f]{32}$/);
  });
});

describe("permissions", () => {
  it("supports exact and wildcard grants", () => {
    expect(can(["projects:read"], "projects:read")).toBe(true);
    expect(can(["projects:*"], "projects:write")).toBe(true);
    expect(can(["*"], "roles:write")).toBe(true);
    expect(can(["projects:read"], "projects:write")).toBe(false);
  });
});

describe("pricing", () => {
  it("returns exact cents and null for unknown models", () => {
    expect(
      costCents({ model: "gpt-5.5-mini", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(225);
    expect(costCents({ model: "gpt-5.5-mini", inputTokens: 1, outputTokens: 1 })).toBe(0.000225);
    expect(costCents({ model: "missing", inputTokens: 1, outputTokens: 1 })).toBeNull();
  });

  it("resolves dated provider model ids to a price", () => {
    // What Anthropic actually returns in usage — must still cost out.
    expect(
      costCents({ model: "claude-haiku-4-5-20251001", inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(80);
    expect(
      costCents({ model: "gpt-5.5-2025-11-01", inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBe(1000);
  });

  it("prices the default GPT-5.6 family and its alias", () => {
    expect(
      costCents({
        model: "gpt-5.6-sol",
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBe(4175);
    expect(costCents({ model: "gpt-5.6", inputTokens: 1_000_000, outputTokens: 0 })).toBe(500);
    expect(
      costCents({ model: "gpt-5.6-terra", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(1750);
    expect(
      costCents({ model: "gpt-5.6-luna", inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBe(700);
  });
});

describe("provider base URL validation", () => {
  const resolveHost = async (host: string) => {
    if (host === "api.anthropic.com") return ["160.79.104.10"];
    if (host === "api.openai.com") return ["172.64.154.211"];
    if (host === "private.example") return ["10.1.2.3"];
    return [host];
  };

  it("blocks metadata, loopback, private, and carrier-grade NAT addresses", async () => {
    await expect(
      validateProviderBaseUrl("https://169.254.169.254/latest/meta-data", { resolveHost }),
    ).rejects.toThrow("provider_base_url_private_host");
    await expect(validateProviderBaseUrl("https://127.0.0.1/v1", { resolveHost })).rejects.toThrow(
      "provider_base_url_private_host",
    );
    await expect(validateProviderBaseUrl("https://10.1.2.3/v1", { resolveHost })).rejects.toThrow(
      "provider_base_url_private_host",
    );
    await expect(validateProviderBaseUrl("https://100.64.0.1/v1", { resolveHost })).rejects.toThrow(
      "provider_base_url_private_host",
    );
    await expect(
      validateProviderBaseUrl("https://private.example/v1", { resolveHost }),
    ).rejects.toThrow("provider_base_url_private_host");
    // Special-use ranges that must also be refused: 0.0.0.0/8, multicast/reserved
    // (>=224), broadcast, and the TEST-NET documentation range.
    for (const host of [
      "0.0.0.0",
      "224.0.0.1",
      "239.255.255.250",
      "255.255.255.255",
      "192.0.2.1",
    ]) {
      await expect(
        validateProviderBaseUrl(`https://${host}/v1`, { resolveHost: async () => [host] }),
      ).rejects.toThrow("provider_base_url_private_host");
    }
  });

  it("allows standard public provider endpoints", async () => {
    await expect(
      validateProviderBaseUrl("https://api.anthropic.com/v1", { resolveHost }),
    ).resolves.toBe("https://api.anthropic.com/v1");
    await expect(
      validateProviderBaseUrl("https://api.openai.com/v1", { resolveHost }),
    ).resolves.toBe("https://api.openai.com/v1");
  });

  it("allows HTTP localhost only when explicitly enabled for dev", async () => {
    await expect(
      validateProviderBaseUrl("http://127.0.0.1:4411/v1", { resolveHost }),
    ).rejects.toThrow("provider_base_url_https_required");
    await expect(
      validateProviderBaseUrl("http://127.0.0.1:4411/v1", {
        allowLocalhostHttp: true,
        resolveHost,
      }),
    ).resolves.toBe("http://127.0.0.1:4411/v1");
  });
});

describe("crypto", () => {
  it("seals and opens plaintext", async () => {
    const sealed = await seal("secret", masterKey);
    expect(await open(sealed, masterKey)).toBe("secret");
  });

  it("hashes and verifies API keys", async () => {
    const hash = await hashKey("fak_secret");
    expect(await verifyKey("fak_secret", hash)).toBe(true);
    expect(await verifyKey("wrong", hash)).toBe(false);
    const key = await generateApiKey("fak");
    expect(key.secret).toMatch(/^fak_[0-9a-f]{40}$/);
    expect(key.last4).toBe(key.secret.slice(-4));
  });

  it("rejects expired and tampered confirmations", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const token = mintConfirmation({
      secret: "confirm",
      userId: "user_1",
      clientId: "client",
      toolName: "write",
      argsHash: "abc",
      summary: "do it",
      ttlMs: 1_000,
    });
    expect(verifyConfirmation(token, "confirm")?.userId).toBe("user_1");
    expect(verifyConfirmation(`${token.slice(0, -1)}x`, "confirm")).toBeNull();
    vi.advanceTimersByTime(1_001);
    expect(verifyConfirmation(token, "confirm")).toBeNull();
    vi.useRealTimers();
  });
});

describe("fingerprints", () => {
  it("diffs manifests within managed paths", () => {
    const expected = manifestFor([
      { path: "a", content: "one" },
      { path: "b", content: "two" },
    ]);
    const actual = manifestFor([
      { path: "a", content: "changed" },
      { path: "c", content: "extra" },
    ]);
    expect(diffManifest(expected, actual, ["a", "b", "c"])).toEqual({
      missing: ["b"],
      modified: ["a"],
      extra: ["c"],
    });
  });
});

describe("render", () => {
  it("matches the real CLI init output byte-for-byte", async () => {
    const dir = mkdtempSync(join(tmpdir(), "facility-core-render-"));
    writeFileSync(
      join(dir, "package.json"),
      `${JSON.stringify(
        {
          scripts: {
            setup: "node setup.mjs",
            typecheck: "tsc --noEmit",
            test: "vitest run",
          },
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    mkdirSync(join(dir, "migrations"), { recursive: true });
    writeFileSync(join(dir, "migrations/001.sql"), "select 1;\n");
    execFileSync("node", [
      join(process.cwd(), "../cli/bin/facility.mjs"),
      "init",
      "--yes",
      "--dir",
      dir,
      "--branch",
      "main",
      "--provision",
      "pnpm run setup",
      "--checks",
      "pnpm run typecheck, pnpm run test",
      "--modules",
      "database",
    ]);
    const cliFiles = collect(dir);
    const rendered = await renderFacilityInit({
      defaultBranch: "main",
      provisionCmd: "pnpm run setup",
      checkCmds: ["pnpm run typecheck", "pnpm run test"],
      modules: ["database"],
      packageManager: "pnpm",
      workflowNames: [],
    });
    const coreFiles = new Map(
      rendered.files.map((file) => [
        file.path,
        {
          mode: file.mode ?? (file.executable ? "100755" : "100644"),
          content: file.content,
        },
      ]),
    );
    expect([...coreFiles.keys()].sort()).toEqual([...cliFiles.keys()].sort());
    for (const [path, cliFile] of cliFiles) {
      expect(coreFiles.get(path), path).toEqual(cliFile);
    }
  });

  it("keeps platform-lane slash commands out of repo workflows", async () => {
    const rendered = await renderFacilityInit({
      defaultBranch: "main",
      execution_lane: { architect: "platform", builder: "platform" },
    });
    const byPath = new Map(rendered.files.map((file) => [file.path, file.content]));
    const crew = byPath.get(".github/workflows/facility-crew.yml") ?? "";
    const codex = byPath.get(".github/workflows/facility-codex.yml") ?? "";

    expect(crew).toContain("false && contains(github.event.comment.body, '/builder')");
    expect(crew).toContain("false && contains(github.event.comment.body, '/architect')");
    expect(codex).toContain("true && contains(github.event.comment.body, '/codex-builder')");
    expect(codex).toContain("true && contains(github.event.comment.body, '/codex-architect')");
  });
});

function collect(root: string): Map<string, { mode: string; content: string }> {
  const out = new Map<string, { mode: string; content: string }>();
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry === "package.json" || entry === "pnpm-lock.yaml" || entry === "migrations")
        continue;
      const path = join(dir, entry);
      const stat = lstatSync(path);
      const rel = relative(root, path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isSymbolicLink()) out.set(rel, { mode: "120000", content: readlinkSync(path) });
      else
        out.set(rel, {
          mode: stat.mode & 0o111 ? "100755" : "100644",
          content: readFileSync(path, "utf8"),
        });
    }
  };
  visit(root);
  return out;
}

describe("audit", () => {
  it("hashes deterministically", () => {
    const first = hashChain(null, { b: 2, a: 1 });
    expect(hashChain(null, { a: 1, b: 2 })).toBe(first);
    expect(hashChain(first, { a: 1 })).not.toBe(first);
    expect(hashChain(null, { z: 1, ä: 2, A: 3, a: 4 })).toBe(
      "5347c7c917380c15ab8fbf413dccbddcca3bdfc3df03905c0e54cfe788c83289",
    );
  });

  it("hashes the JSON value that persistence retains", () => {
    expect(hashChain(null, { status: "succeeded", error: undefined })).toBe(
      hashChain(null, { status: "succeeded" }),
    );
    expect(hashChain(null, { values: [undefined, "kept"] })).toBe(
      hashChain(null, { values: [null, "kept"] }),
    );
  });
});

describe("receipts", () => {
  it("maps legacy agent receipts to facility receipts", () => {
    const receipt = parseLegacyAgentReceipt({
      schema: "example.agent_sdlc.run.v1",
      provider: "codex_cli",
      mode: "builder",
      result: "succeeded",
      usage: { input_tokens: 100, output_tokens: 50, cost_usd: 1.235, cost_source: "provider" },
      activity: { turns: 2, shell_commands: 1, file_changes: 3, mcp_tool_calls: 0, errors: 0 },
      github: { owner: "example", repo: "product", actor: "octo" },
      timing: { started_at: "2026-01-01T00:00:00Z", duration_ms: 1000 },
      checks: [{ name: "pnpm test", status: "passed", source: "platform", exit_code: 0 }],
    });
    expect(receipt.schema).toBe("facility.run.v1");
    expect(receipt.usage.cost_cents).toBe(124);
    expect(receipt.github?.actor_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt.checks).toEqual([
      { name: "pnpm test", status: "passed", source: "platform", exit_code: 0 },
    ]);
  });

  it("seals a receipt and detects payload changes", () => {
    const base = parseLegacyAgentReceipt({
      schema: "example.agent_sdlc.run.v1",
      provider: "codex_cli",
      mode: "builder",
      result: "succeeded",
      usage: { input_tokens: 10, output_tokens: 5, cost_usd: 0.01, cost_source: "provider" },
      activity: {},
      timing: { started_at: "2026-07-19T00:00:00.000Z" },
    });
    const sealed = sealFacilityReceipt(base, "a".repeat(64));
    expect(sealed.integrity).toEqual({
      algorithm: "sha256",
      previous_sha256: "a".repeat(64),
      payload_sha256: receiptContentDigest(sealed),
    });
    expect(sealed.integrity?.payload_sha256).toBe(
      "772c4970f519bb800bafef9f62c5f072b893555afef1f0d36f0839fc6b318a9d",
    );
    expect(verifyFacilityReceipt(sealed)).toBe(true);
    expect(verifyFacilityReceipt({ ...sealed, result: "failed" })).toBe(false);
    expect(
      verifyFacilityReceipt({
        ...sealed,
        integrity: { ...sealed.integrity, previous_sha256: null } as never,
      }),
    ).toBe(false);
  });
});
