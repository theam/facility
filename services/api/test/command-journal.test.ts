import { describe, expect, it } from "vitest";
import { CommandJournal } from "../src/workspaces/command-journal.js";

const frame = (seq: number, stream: string, data: Buffer | string) =>
  `${JSON.stringify({ seq, stream, data: Buffer.from(data).toString("base64") })}\n`;

describe("durable command output", () => {
  it("recovers the completion event in order and tolerates replay without duplicating output", () => {
    const output: string[] = [];
    const journal = new CommandJournal(({ data }) => output.push(data));
    const events =
      frame(0, "stdout", "done") +
      `${JSON.stringify({ seq: 1, type: "exit", exitCode: 7, durationMs: 123 })}\n`;
    journal.push(events);
    journal.restart();
    journal.push(events);
    journal.finish();
    expect(journal.result).toEqual({ exitCode: 7, durationMs: 123 });
    expect(journal.nextSequence).toBe(2);
    expect(output).toEqual(["done"]);
    expect(() => journal.push(frame(2, "stdout", "late"))).toThrow("after exit");
  });

  it.each([
    { seq: 0, type: "exit", exitCode: -1, durationMs: 1 },
    { seq: 0, type: "exit", exitCode: 256, durationMs: 1 },
    { seq: 0, type: "exit", exitCode: 0, durationMs: -1 },
    { seq: 0, type: "exit", exitCode: 0 },
  ])("rejects malformed completion events", (event) => {
    const journal = new CommandJournal(() => undefined);
    expect(() => journal.push(`${JSON.stringify(event)}\n`)).toThrow("Invalid");
    expect(journal.result).toBeUndefined();
  });
  it("replays frames across changing chunks without repeating text or breaking UTF-8", () => {
    const output: string[] = [];
    const journal = new CommandJournal(({ data }) => output.push(data));
    const bytes = Buffer.from("hello 🌍");
    const first = frame(0, "stdout", bytes.subarray(0, 8));
    journal.push(first.slice(0, 9));
    journal.push(first.slice(9));
    journal.restart();
    journal.push(first + frame(1, "stdout", bytes.subarray(8)) + frame(2, "stdout", "hello 🌍"));
    journal.finish();
    expect(output.join("")).toBe("hello 🌍hello 🌍");
  });

  it("recovers a missing range from the journal without discarding already delivered output", () => {
    const output: string[] = [];
    const journal = new CommandJournal(({ data }) => output.push(data));
    journal.push(frame(0, "stdout", "first"));
    expect(() => journal.push(frame(2, "stdout", "last"))).toThrow("gap");
    journal.restart();
    journal.push(
      frame(0, "stdout", "first") + frame(1, "stderr", "middle") + frame(2, "stdout", "last"),
    );
    journal.finish();
    expect(output).toEqual(["first", "middle", "last"]);
  });

  it.each([
    '{"seq":-1,"stream":"stdout","data":""}\n',
    '{"seq":0,"stream":"stdin","data":""}\n',
    '{"seq":0,"stream":"stdout","data":"%%%"}\n',
  ])("rejects malformed frames without emitting their content", (data) => {
    const output: string[] = [];
    const journal = new CommandJournal(({ data }) => output.push(data));
    expect(() => journal.push(data)).toThrow("Invalid");
    expect(output).toEqual([]);
  });

  it("does not silently accept an incomplete final frame", () => {
    const journal = new CommandJournal(() => undefined);
    journal.push('{"seq":0');
    expect(() => journal.finish()).toThrow("incomplete");
  });
});
