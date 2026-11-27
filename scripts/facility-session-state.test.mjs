import assert from "node:assert/strict";
import { test } from "node:test";
import { containerStartId, processStat, sessionProcess } from "../runner/facility-session-state.mjs";

const directory = "/workspace/.facility/interactive/turn_fixture";
function stat(pid, start, group = pid, state = "S") {
  const fields = Array(20).fill("0");
  fields[0] = state;
  fields[2] = String(group);
  fields[19] = String(start);
  return `${pid} (a native (process)) ${fields.join(" ")}`;
}
function fixture({ epoch = "host:100", pid = "42", processStart = 200, markerStart = 200, owner = directory } = {}) {
  const files = new Map([
    ["/proc/sys/kernel/random/boot_id", "host\n"],
    ["/proc/1/stat", stat(1, 100)],
    [`${directory}/launch.json`, JSON.stringify({ containerStartId: epoch })],
    [`${directory}/pid`, pid],
    [`${directory}/process.json`, JSON.stringify({ pid: 42, start: String(markerStart) })],
    [`${directory}/tty`, ""],
    ["/proc/42/stat", stat(42, processStart)],
    ["/proc/42/environ", `FACILITY_SESSION_DIRECTORY=${owner}\0SECRET=never emitted`],
  ]);
  const io = {
    exists: (path) => files.has(path),
    read(path) {
      if (!files.has(path)) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      return files.get(path);
    },
  };
  return { files, io, state: () => sessionProcess(directory, io) };
}

test("container identity changes across restarts even when the kernel boot ID is retained", () => {
  const value = fixture();
  assert.equal(containerStartId(value.io.read), "host:100");
  value.files.set("/proc/1/stat", stat(1, 300));
  assert.equal(containerStartId(value.io.read), "host:300");
  assert.deepEqual(value.state(), { epoch: "host:300", stale: true, exited: true, interrupted: true });
});
test("a matching live native process survives API restarts and replica changes", () => {
  const value = fixture();
  assert.deepEqual(value.state(), { epoch: "host:100", pid: 42, exited: false });
  assert.deepEqual(value.state(), { epoch: "host:100", pid: 42, exited: false });
});
test("old-container markers never consult a reused PID in the new container", () => {
  const value = fixture({ epoch: "host:99", owner: "/another/session" });
  value.files.delete("/proc/42/environ");
  assert.deepEqual(value.state(), { epoch: "host:100", stale: true, exited: true, interrupted: true });
});
test("missing, zombie and reused native PIDs mean interrupted execution", () => {
  for (const change of [
    (files) => files.delete("/proc/42/stat"),
    (files) => files.set("/proc/42/stat", stat(42, 200, 42, "Z")),
    (files) => files.set("/proc/42/stat", stat(42, 201)),
  ]) {
    const value = fixture();
    change(value.files);
    assert.deepEqual(value.state(), { epoch: "host:100", exited: true, interrupted: true });
  }
});
test("a current PID with a different owner or an invalid marker stays fenced", () => {
  assert.throws(fixture({ owner: "/another/session" }).state, /identity changed/);
  for (const pid of ["1", "0", "invalid", "-42"])
    assert.throws(fixture({ pid }).state, /Invalid native process/);
});
test("unreadable process evidence is not treated as a confirmed stop", () => {
  const value = fixture();
  const read = value.io.read;
  value.io.read = (path) => {
    if (path === "/proc/42/environ") throw Object.assign(new Error("denied"), { code: "EACCES" });
    return read(path);
  };
  assert.throws(value.state, /denied/);
});
test("completed and interrupted exits stay distinct from a starting terminal", () => {
  const value = fixture();
  value.files.set(`${directory}/exit`, "0");
  assert.deepEqual(value.state(), { epoch: "host:100", exited: true, interrupted: false });
  value.files.set(`${directory}/exit`, "interrupted");
  assert.deepEqual(value.state(), { epoch: "host:100", exited: true, interrupted: true });
  value.files.delete(`${directory}/exit`);
  value.files.delete(`${directory}/pid`);
  assert.deepEqual(value.state(), { epoch: "host:100", starting: true, exited: false });
});
test("process stat handles spaces and parentheses and refuses malformed identities", () => {
  assert.deepEqual(processStat(stat(42, 300, 41)), { state: "S", group: 41, start: "300" });
  assert.throws(() => processStat("not a process stat"), /Cannot verify/);
});
