import { describe, expect, it } from "vitest";
import { redactEvent } from "../src/turns/redaction.js";

describe("structured agent event redaction", () => {
  it("redacts short and quoted values without corrupting JSON primitives or nested events", () => {
    const input = {
      exitCode: 0,
      ok: true,
      nested: [null, 10, false, { output: '0 true a"b' }],
      'a"b': "quoted",
    };
    expect(redactEvent(input, ["0", "true", 'a"b'])).toEqual({
      exitCode: 0,
      ok: true,
      nested: [null, 10, false, { output: "[REDACTED] [REDACTED] [REDACTED]" }],
      "[REDACTED]": "quoted",
    });
    expect(input.nested[3]).toEqual({ output: '0 true a"b' });
  });
});
