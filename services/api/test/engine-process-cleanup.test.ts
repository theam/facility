import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { ENGINE_PROCESS_CLEANUP } from "../src/turns/engine-process-cleanup.js";

type Process = {
  group: number;
  turn?: string;
  state?: string;
  resistsTerm?: boolean;
  immortal?: boolean;
  readable?: boolean;
};
async function cleanup(initial: Record<number, Process>, native = true) {
  const processes = new Map(
    Object.entries(initial).map(([pid, value]) => [
      Number(pid),
      { ...value, state: value.state ?? "S" },
    ]),
  );
  const markers = new Map<string, string>([["turn_fixture.pid", "100"]]);
  if (native) markers.set("turn_fixture.native.pid", "101");
  const signals: Array<{ pid: number; signal: string }> = [];
  let output = "",
    error = "";
  const errno = (code: string) => Object.assign(new Error(code), { code });
  const fs = {
    existsSync: (file: string) => markers.has(file.split("/").at(-1) ?? ""),
    readdirSync: () => [...processes.keys()].map(String),
    readFileSync(file: string) {
      if (file.includes("engine-processes")) {
        const value = markers.get(file.split("/").at(-1) ?? "");
        if (value === undefined) throw errno("ENOENT");
        return value;
      }
      const [, pid, part] = file.match(/^\/proc\/(\d+)\/(stat|environ)$/) ?? [];
      const value = processes.get(Number(pid));
      if (!value) throw errno("ENOENT");
      if (part === "stat") return `${pid} (native helper) ${value.state} 1 ${value.group}`;
      if (value.readable === false) throw errno("EACCES");
      return `FACILITY_TURN_ID=${value.turn ?? "another_turn"}\0SECRET=not-for-output`;
    },
    unlinkSync: (file: string) => {
      markers.delete(file.split("/").at(-1) ?? "");
    },
  };
  const process = {
    env: { HOME: "/workspace/.facility/home", FACILITY_INTERRUPTED_TURN_ID: "turn_fixture" },
    pid: 9999,
    platform: "linux",
    exitCode: 0,
    stdout: {
      write: (value: string) => {
        output += value;
      },
    },
    stderr: {
      write: (value: string) => {
        error += value;
      },
    },
    kill(pid: number, signal: string) {
      signals.push({ pid, signal });
      for (const [id, value] of processes) {
        if (!(pid < 0 ? value.group === -pid : id === pid)) continue;
        if (value.immortal || (signal === "SIGTERM" && value.resistsTerm)) continue;
        value.state = "Z";
      }
    },
  };
  await runInNewContext(ENGINE_PROCESS_CLEANUP, {
    require: (name: string) =>
      name === "node:fs"
        ? fs
        : name === "node:path"
          ? {
              dirname: (v: string) => v.slice(0, v.lastIndexOf("/")),
              join: (...v: string[]) => v.join("/"),
            }
          : undefined,
    process,
    setTimeout: (resolve: () => void) => {
      resolve();
    },
  });
  return { processes, markers, signals, output, error, exitCode: process.exitCode };
}

describe("native writer stop confirmation", () => {
  it.each([
    true,
    false,
  ])("requires a provider compute fence when only an unauthenticated native group survives: leader present=%s", async (leaderPresent) => {
    const processes: Record<number, Process> = { 102: { group: 101, resistsTerm: true } };
    if (leaderPresent) processes[101] = { group: 101, turn: "turn_fixture" };
    const result = await cleanup(processes);
    expect(result.output).toBe("compute-fence-required");
    expect(result.exitCode).toBe(0);
    expect(result.markers.size).toBe(2);
    expect(result.processes.get(102)?.state).toBe("S");
    expect(result.signals).not.toContainEqual({ pid: 102, signal: "SIGKILL" });
  });

  it("hard-stops the native process group and legacy supervisor without touching another turn", async () => {
    const result = await cleanup({
      100: { group: 5, turn: "turn_fixture" },
      101: { group: 101, turn: "turn_fixture", resistsTerm: true },
      102: { group: 101, resistsTerm: true },
      200: { group: 200, turn: "turn_other", resistsTerm: true },
    });
    expect(result.output).toBe("stopped");
    expect(result.exitCode).toBe(0);
    expect(result.signals).toContainEqual({ pid: -101, signal: "SIGKILL" });
    expect(result.processes.get(102)?.state).toBe("Z");
    expect(result.processes.get(200)?.state).toBe("S");
    expect(result.markers.size).toBe(0);
    expect(result.output + result.error).not.toContain("not-for-output");
  });

  it("also stops old non-grouped monitor children identified by the exact turn tag", async () => {
    const result = await cleanup(
      {
        100: { group: 5, turn: "turn_fixture" },
        101: { group: 5, turn: "turn_fixture", resistsTerm: true },
        200: { group: 5 },
      },
      false,
    );
    expect(result.output).toBe("stopped");
    expect(result.signals).toContainEqual({ pid: 101, signal: "SIGKILL" });
    expect(result.processes.get(200)?.state).toBe("S");
  });

  it("refuses to claim stopped when the writer survives hard termination", async () => {
    const result = await cleanup({
      100: { group: 5, turn: "turn_fixture" },
      101: { group: 101, turn: "turn_fixture", immortal: true },
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("");
    expect(result.markers.size).toBe(2);
  });

  it("does not kill another turn when a stale marker's PID was reused", async () => {
    const result = await cleanup({ 100: { group: 100, turn: "turn_other" } }, false);
    expect(result.output).toBe("stale-marker");
    expect(result.signals).toEqual([]);
    expect(result.processes.get(100)?.state).toBe("S");
  });
});
