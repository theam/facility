import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentManifest } from "@facility/agents";
import { afterEach, expect, it } from "vitest";
import { ClaudeCodeEngine, CodexEngine } from "../src/turns/engines.js";
import { FakeWorkspaceRuntime } from "../src/workspaces/fake.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("authenticates native Codex starts and resumes with a project key, and rejects invalid credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "facility-engine-auth-"));
  roots.push(root);
  const bin = join(root, "bin");
  await mkdir(bin);
  // Match the CLI's documented contract: OPENAI_API_KEY alone is not codex exec authentication.
  await writeFile(
    join(bin, "codex"),
    `#!/bin/sh
if test "$CODEX_API_KEY" != "project-a-key"; then echo "401 Unauthorized" >&2; exit 1; fi
printf '%s\\n' '{"type":"thread.started","thread_id":"authenticated-thread"}'
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(bin, "claude"),
    `#!/bin/sh
if test -n "$CODEX_API_KEY"; then echo "unexpected Codex credential" >&2; exit 1; fi
printf '%s\\n' '{"type":"result","session_id":"claude-session","result":"ready"}'
`,
    { mode: 0o755 },
  );
  const runtime = new FakeWorkspaceRuntime(join(root, "workspaces"));
  const workspace = await runtime.create({ id: "ws_0123456789abcdef", image: "runner:test" });
  const environment = { PATH: `${bin}:${process.env.PATH}`, OPENAI_API_KEY: "project-a-key" };
  const request = {
    turnId: "turn_credentials",
    workspace,
    prompt: "work",
    cwd: ".",
    environment,
    manifest: parseAgentManifest(
      `---
name: builder
description: Credential contract test.
engine: codex
model: gpt-5.5
enabled: true
triggers:
  - type: manual
---
Work.`,
      "builder.md",
    ),
  };
  const engine = new CodexEngine(runtime);
  const first = await engine.run(request);
  expect(first.nativeSessionId).toBe("authenticated-thread");
  await runtime.suspend(workspace);
  await expect(
    engine.run({ ...request, nativeSessionId: first.nativeSessionId }),
  ).resolves.toMatchObject({ nativeSessionId: first.nativeSessionId });
  for (const key of ["", "malformed", "revoked-key", "project-b-key"]) {
    await expect(
      engine.run({ ...request, environment: { ...environment, CODEX_API_KEY: key } }),
    ).rejects.toMatchObject({ code: "agent_engine_failed", message: "401 Unauthorized" });
  }
  await expect(
    engine.run({ ...request, environment: { ...environment, OPENAI_API_KEY: "" } }),
  ).rejects.toMatchObject({ code: "agent_engine_failed" });
  // A prior invocation must not leave its alias in the request or affect the other engine.
  expect(environment).not.toHaveProperty("CODEX_API_KEY");
  await expect(
    new ClaudeCodeEngine(runtime).run({
      ...request,
      environment: { ...environment, CODEX_API_KEY: "" },
    }),
  ).resolves.toMatchObject({ nativeSessionId: "claude-session" });
});
