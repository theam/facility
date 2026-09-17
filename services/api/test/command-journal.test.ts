import { describe, expect, it } from "vitest";
import { CommandJournal } from "../src/workspaces/command-journal.js";

const frame = (seq: number, stream: string, data: Buffer | string) =>
  `${JSON.stringify({ seq, stream, data: Buffer.from(data).toString("base64") })}\n`;

describe("durable command output", () => {
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
