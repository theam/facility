import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { COMMAND_JOURNAL_WRAPPER, CommandJournal } from "../src/workspaces/command-journal.js";

it("journals an actual child process byte for byte with private file permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "command-journal-"));
  const path = join(root, "output", "command.ndjson");
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      "-e",
      COMMAND_JOURNAL_WRAPPER,
      path,
      process.execPath,
      "-e",
      'process.stdout.write("hello 🌍\\n"); process.stderr.write("warning\\n");',
    ]);
    expect(await readFile(`${path}.0`, "utf8")).toBe(stdout);
    expect((await stat(`${path}.0`)).mode & 0o777).toBe(0o600);
    const output = { stdout: "", stderr: "" };
    const journal = new CommandJournal(({ stream, data }) => {
      output[stream] += data;
    });
    journal.push(stdout);
    journal.finish();
    expect(output).toEqual({ stdout: "hello 🌍\n", stderr: "warning\n" });
    expect(journal.result).toMatchObject({ exitCode: 0 });
    expect(journal.result?.durationMs).toBeGreaterThanOrEqual(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rotates large output into bounded journal segments without losing bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "command-journal-"));
  const path = join(root, "output");
  try {
    await promisify(execFile)(
      process.execPath,
      [
        "-e",
        COMMAND_JOURNAL_WRAPPER,
        path,
        process.execPath,
        "-e",
        'process.stdout.write("α".repeat(200_000));',
      ],
      { maxBuffer: 2 * 1024 * 1024 },
    );
    const segments = (await readdir(root)).sort();
    expect(segments.length).toBeGreaterThan(1);
    let output = "";
    const journal = new CommandJournal(({ data }) => {
      output += data;
    });
    for (const segment of segments) {
      const data = await readFile(join(root, segment));
      expect(data.length).toBeLessThan(512 * 1024);
      journal.push(data.toString("utf8"));
    }
    journal.finish();
    expect(output).toBe("α".repeat(200_000));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("persists a real failed process exit alongside its last output", async () => {
  const root = await mkdtemp(join(tmpdir(), "command-journal-"));
  const path = join(root, "output");
  try {
    await expect(
      promisify(execFile)(process.execPath, [
        "-e",
        COMMAND_JOURNAL_WRAPPER,
        path,
        process.execPath,
        "-e",
        'process.stdout.write("last output"); process.exitCode = 7;',
      ]),
    ).rejects.toMatchObject({ code: 7 });
    let output = "";
    const journal = new CommandJournal((event) => {
      output += event.data;
    });
    journal.push(await readFile(`${path}.0`, "utf8"));
    journal.finish();
    expect(output).toBe("last output");
    expect(journal.result).toMatchObject({ exitCode: 7 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
