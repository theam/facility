import { existsSync, readFileSync } from "node:fs";

export function processStat(stat) {
  const fields = stat
    .slice(stat.lastIndexOf(") ") + 2)
    .trim()
    .split(/\s+/);
  if (!/^\d+$/.test(fields[19] ?? "") || !/^\d+$/.test(fields[2] ?? ""))
    throw new Error("Cannot verify native process identity");
  return { state: fields[0], group: Number(fields[2]), start: fields[19] };
}

// Docker shares the host boot ID. PID 1's start time also changes on a restart
// of the same container, while the retained workspace volume does not.
export function containerStartId(read = readFileSync) {
  return `${read("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${processStat(read("/proc/1/stat", "utf8")).start}`;
}

export function sessionProcess(directory, { read = readFileSync, exists = existsSync } = {}) {
  const epoch = containerStartId(read);
  const config = exists(`${directory}/launch.json`)
    ? JSON.parse(read(`${directory}/launch.json`, "utf8"))
    : undefined;
  if (config?.containerStartId && config.containerStartId !== epoch)
    return { epoch, stale: true, exited: true, interrupted: true };
  if (exists(`${directory}/exit`))
    return {
      epoch,
      exited: true,
      interrupted: read(`${directory}/exit`, "utf8") === "interrupted",
    };
  if (!exists(`${directory}/pid`))
    return { epoch, starting: exists(`${directory}/tty`), exited: false };
  const pid = Number(read(`${directory}/pid`, "utf8"));
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error("Invalid native process");
  try {
    const stat = processStat(read(`/proc/${pid}/stat`, "utf8"));
    const identity = exists(`${directory}/process.json`)
      ? JSON.parse(read(`${directory}/process.json`, "utf8"))
      : undefined;
    if (stat.state === "Z" || (identity && (identity.pid !== pid || identity.start !== stat.start)))
      return { epoch, exited: true, interrupted: true };
    const environment = read(`/proc/${pid}/environ`, "utf8");
    if (!environment.split("\0").includes(`FACILITY_SESSION_DIRECTORY=${directory}`))
      throw new Error("Native process identity changed");
    return { epoch, pid, exited: false };
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH")
      return { epoch, exited: true, interrupted: true };
    throw error;
  }
}
