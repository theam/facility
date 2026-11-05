import Docker from "dockerode";
import { ReviewCycleStop } from "../stories/review-cycle-rules.js";

export type ReviewSandbox = (
  argv: string[],
  files: Array<{ path: string; text: string }>,
  signal: AbortSignal,
) => Promise<{ exitCode: number; output: string }>;

const RUN_TEST = [
  'const fs = require("node:fs");',
  'const path = require("node:path");',
  'const { spawnSync } = require("node:child_process");',
  "const { files, argv } = JSON.parse(process.argv[1]);",
  'const root = fs.mkdtempSync("/tmp/review-");',
  "for (const file of files) {",
  "  const dest = path.resolve(root, file.path);",
  '  if (!dest.startsWith(root + "/")) process.exit(2);',
  "  fs.mkdirSync(path.dirname(dest), { recursive: true });",
  '  fs.writeFileSync(dest, file.text, { flag: "wx" });',
  "}",
  "const result = spawnSync(argv[0], argv.slice(1), { cwd: root, timeout: 15000,",
  '  killSignal: "SIGKILL", maxBuffer: 8192, encoding: "utf8",',
  '  env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: "/tmp", CI: "true" } });',
  'console.log("facility-review-result:" + JSON.stringify({ exitCode: result.status ?? 1, output: (result.stdout ?? "") + (result.stderr ?? "") }));',
].join("\n");

/** A fresh, credential-free test container. It receives bounded pinned text and fixed operator argv. */
export function dockerReviewSandbox(image: string, docker = new Docker()): ReviewSandbox {
  return async (argv, files, signal) => {
    const data = JSON.stringify({ argv, files });
    if (Buffer.byteLength(data) > 65_536)
      throw new ReviewCycleStop("The isolated test snapshot exceeds its limit.");
    signal.throwIfAborted();
    const container = await docker.createContainer({
      Image: image,
      Entrypoint: ["node", "-e"],
      Cmd: [RUN_TEST, data],
      User: "65534:65534",
      WorkingDir: "/tmp",
      Env: ["HOME=/tmp"],
      Tty: true,
      NetworkDisabled: true,
      Labels: { "facility.workload.kind": "delivery-review-test" },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Init: true,
        PidsLimit: 64,
        Memory: 256 * 1024 * 1024,
        LogConfig: { Type: "json-file", Config: { "max-size": "64k", "max-file": "1" } },
        NanoCpus: 1_000_000_000,
        Tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=16m,mode=1777" },
      },
    });
    const stop = () => {
      void container.kill().catch(() => undefined);
    };
    const limit = AbortSignal.any([signal, AbortSignal.timeout(20_000)]);
    limit.addEventListener("abort", stop, { once: true });
    try {
      limit.throwIfAborted();
      await container.start({ abortSignal: limit });
      if (limit.aborted) stop();
      const status = await container.wait({ abortSignal: limit });
      limit.throwIfAborted();
      if (status.StatusCode !== 0)
        throw new ReviewCycleStop("The isolated verification process failed.");
      const raw = await container.logs({ stdout: true, stderr: true, abortSignal: limit });
      if (!Buffer.isBuffer(raw) || raw.length > 65_536)
        throw new ReviewCycleStop("Isolated verification returned invalid evidence.");
      const prefix = "facility-review-result:";
      const response = raw.toString("utf8").trim();
      if (!response.startsWith(prefix))
        throw new ReviewCycleStop("Isolated verification returned invalid evidence.");
      const parsed = JSON.parse(response.slice(prefix.length)) as {
        exitCode?: unknown;
        output?: unknown;
      };
      if (typeof parsed.exitCode !== "number" || typeof parsed.output !== "string")
        throw new ReviewCycleStop("Isolated verification returned invalid evidence.");
      return { exitCode: parsed.exitCode, output: parsed.output };
    } finally {
      limit.removeEventListener("abort", stop);
      await container.remove({ force: true, v: true }).catch(() => undefined);
    }
  };
}
