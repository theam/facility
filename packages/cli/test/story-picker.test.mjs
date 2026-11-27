import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { main } from "../src/cli.mjs";
import { filterStories, pickStory } from "../src/story-picker.mjs";

const stories = Array.from({ length: 17 }, (_, index) => ({
  id: `story_${index}`, title: index === 16 ? "Review login" : `Build task ${index}`,
  project: { id: "proj_demo", slug: "demo", name: "Demo project" },
  issue: { number: 100 + index }, phase: index === 16 ? "ready" : "attention",
  attention: index === 16 ? [] : [{ id: `attention_${index}` }],
  session: { holder: index === 16 ? { name: "Ada", since: "2026-01-01T00:00:00Z" } : null },
}));

function terminal(answers) {
  const stdin = new PassThrough(); const stdout = new PassThrough(); let transcript = "";
  stdout.on("data", (chunk) => {
    const value = chunk.toString(); transcript += value;
    if (value.includes("Search or select:")) queueMicrotask(() => {
      if (!answers.length) stdin.end();
      else stdin.write(`${answers.shift()}\n`);
    });
  });
  return { stdin, stdout, transcript: () => transcript };
}

test("story search combines title, project, issue, id, phase and holder without changing scope", () => {
  for (const query of ["REVIEW demo", "116 ada", "demo#116", "story_16 ready", "Demo project login"])
    assert.deepEqual(filterStories(stories, query, false), [stories[16]]);
  assert.deepEqual(filterStories(stories, "Ada", true), []);
  assert.equal(filterStories(stories, "free", true).length, 16);
  assert.equal(filterStories(stories, "", false).length, 17);
  assert.deepEqual(filterStories(stories, "missing", false), []);
});

test("picker defaults to attention and can show all, filter, correct an invalid choice and select", async () => {
  const io = terminal(["/all", "demo review ada", "2", "1"]);
  assert.equal(await pickStory(stories, io), stories[16]);
  assert.match(io.transcript(), /Stories that need you \(16\)/);
  assert.match(io.transcript(), /All stories \(17\)/);
  assert.match(io.transcript(), /demo#116 · Review login · story_16 · ready · Ada since/);
  assert.match(io.transcript(), /Choose a displayed number/);
});

test("picker pages, resets search, and switches back to attention", async () => {
  const io = terminal(["/next", "/prev", "/all", "Review", "/", "/needs-you", "/next", "1"]);
  assert.equal(await pickStory(stories, io), stories[15]);
  assert.match(io.transcript(), /Page 2\/2/);
});

test("empty results remain searchable and numeric queries have an unambiguous spelling", async () => {
  const io = terminal(["missing", "/all", "/116", "1"]);
  assert.equal(await pickStory(stories, io), stories[16]);
  assert.match(io.transcript(), /No matching stories/);
});

test("empty attention, cancel and EOF never attach automatically", async () => {
  const available = [stories[16]];
  const io = terminal(["/all", "1"]);
  assert.equal(await pickStory(available, io), available[0]);
  assert.match(io.transcript(), /Stories that need you \(0\)/);
  assert.equal(await pickStory(stories, terminal(["/cancel"])), null);
  assert.equal(await pickStory(stories, terminal([])), null);
  assert.equal(await pickStory([], terminal([])), null);
});

test("picker strips untrusted terminal controls from every displayed field", async () => {
  const malicious = structuredClone(stories[16]);
  malicious.title = "\x1b]2;injected\x07Review\nspoofed choice\r";
  malicious.project.slug = "\x1b[31mdemo";
  malicious.session.holder.name = "Ada\x1b[2J";
  const io = terminal(["/all", "1"]);
  assert.equal(await pickStory([malicious], io), malicious);
  assert.doesNotMatch(io.transcript(), /\x1b|\x07|\r|\nspoofed/);
});

test("picker closes the readline stream after selecting", async () => {
  const io = terminal(["1"]);
  const before = io.stdin.listenerCount("data");
  await pickStory(stories, io);
  assert.equal(io.stdin.listenerCount("data"), before);
  io.stdin.end(); await once(io.stdin, "finish");
});

test("facility --attach dispatches to the same validated command as facility attach", async (t) => {
  const output = []; const originalLog = console.log;
  console.log = (line) => output.push(line); t.after(() => { console.log = originalLog; });
  assert.equal(await main(["attach", "--help"]), 0);
  assert.equal(await main(["--attach", "--help"]), 0);
  assert.equal(output.length, 2); assert.equal(output[1], output[0]);
  assert.match(output[1], /filter/);
  await assert.rejects(main(["--attach", "--instance"]), /requires a value/);
  await assert.rejects(main(["--attach", "--unknown"]), /Unknown option/);
});
