import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stripVTControlCharacters } from "node:util";
import WebSocket from "ws";
import { accessToken, readCredentials } from "./credentials.mjs";
import { HerdrReporter } from "./herdr.mjs";

export const storyPath = (project, story) => `/v1/projects/${encodeURIComponent(project)}/workspace-stories/${encodeURIComponent(story)}`;
export async function api(instance, path, body) {
  const auth = await accessToken(instance);
  const response = await fetch(`${auth.url}${path}`, { method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(30_000), headers: { authorization: `Bearer ${auth.access_token}`, ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": body.idempotency_key ?? randomUUID() }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.error?.message ?? `Facility request failed (${response.status})`);
  return result;
}
async function projects(instance) {
  const result = [];
  for (let offset = 0;; offset += 100) {
    const page = await api(instance, `/v1/projects?limit=100&offset=${offset}`);
    result.push(...page); if (page.length < 100) return result;
  }
}
export async function listStories(instance, needsYou = false) {
  const result = [];
  for (const project of await projects(instance)) {
    for (let offset = 0;; offset += 100) {
      const page = await api(instance, `/v1/projects/${encodeURIComponent(project.id)}/backlog?phase=all&limit=100&offset=${offset}`);
      for (const item of page.items) if (item.story && (!needsYou || item.attention.length)) result.push({ ...item, project, id: item.story.id });
      if (offset + page.items.length >= page.total || !page.items.length) break;
    }
  }
  return result;
}
export async function resolveStory(instance, reference) {
  if (reference?.startsWith("http")) {
    const auth = await accessToken(instance);
    const url = new URL(reference);
    if (![auth.url, auth.issuer].includes(url.origin)) throw new Error("Story URL belongs to another instance; select its login with --instance");
    const match = /^\/projects\/([^/]+)\/stories\/([^/]+)\/?$/.exec(url.pathname);
    if (!match) throw new Error("Expected a Facility story URL");
    const projectId = decodeURIComponent(match[1]);
    const value = decodeURIComponent(match[2]);
    if (value.startsWith("story_")) return { projectId, storyId: value };
    reference = `${projectId}#${value}`;
  }
  const available = await listStories(instance, !reference);
  if (!reference) {
    if (!available.length) throw new Error("No stories need your attention; use facility stories to list all stories");
    available.forEach((item, index) => console.log(`${index + 1}. ${item.project.slug}: ${item.title}`));
    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const index = Number(await readline.question("Attach to story: ")) - 1;
      if (!Number.isInteger(index) || !available[index]) throw new Error("Invalid story selection");
      reference = available[index].id;
    } finally { readline.close(); }
  }
  const match = /^(.*)#(\d+)$/.exec(reference);
  const found = available.filter((item) => item.id === reference || (match && [item.project.id, item.project.slug].includes(match[1]) && String(item.issue?.number ?? item.story.externalId) === match[2]));
  if (found.length !== 1) throw new Error(found.length ? "Story reference is ambiguous; use the story id" : "Story not found in your accessible projects");
  return { projectId: found[0].project.id, storyId: found[0].id, title: found[0].title };
}

const clean = (value) => stripVTControlCharacters(String(value).replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|$)/g, "")).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
export function renderTurnEvent(event) {
  const data = event.data ?? {};
  if (event.type === "turn.phase") return `∴ ${clean(data.phase)}`;
  if (["turn.failed", "turn_error", "worker_interrupted", "turn.worker_interrupted"].includes(event.type)) return `Turn failed: ${clean(data.error ?? event.type)}`;
  const message = data.message ?? data.payload;
  const content = message?.content;
  if (Array.isArray(content)) return content.map((part) => part.text ? clean(part.text) : part.name ? `● ${clean(part.name)}` : "").filter(Boolean).join("\n");
  const item = data.item;
  if (item?.text) return clean(item.text);
  if (item?.command) return `∴ ${clean(item.command)}`;
  return event.type === "turn.succeeded" ? "Turn completed." : "";
}

export async function attach(instance, reference, { stdin = process.stdin, stdout = process.stdout, reporter: suppliedReporter } = {}) {
  if (!instance && reference?.startsWith("http")) {
    const origin = new URL(reference).origin;
    if ((await readCredentials()).instances[origin]) instance = origin;
  }
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("facility attach requires a terminal");
  const target = await resolveStory(instance, reference);
  const bundle = await api(instance, storyPath(target.projectId, target.storyId));
  const auth = await accessToken(instance);
  const resume = `${auth.url}/projects/${encodeURIComponent(target.projectId)}/stories/${encodeURIComponent(target.storyId)}`;
  const reporter = suppliedReporter ?? new HerdrReporter();
  reporter.attach(bundle.story.title, bundle.turns[0]?.engine, resume);
  const clientId = randomUUID();
  const wasRaw = stdin.isRaw;
  let socket;
  let writer = false;
  let holder;
  let confirmation = null;
  let leaving = false;
  let previous = "";
  let connected = false;
  let exitCode = 0;
  const send = (value) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value)); };
  const resize = () => send({ type: "resize", cols: Math.min(1000, stdout.columns || 100), rows: Math.min(1000, stdout.rows || 30) });
  const input = (data) => {
    if (leaving) return;
    if (data.includes(29)) { leaving = true; send({ type: "leave" }); setTimeout(() => socket?.close(), 3000).unref(); return; }
    if (confirmation) {
      for (const char of data.toString("utf8")) {
        if (char === "\x03") { confirmation = null; stdout.write("\r\nTakeover cancelled.\r\n"); break; }
        if (char === "\r" || char === "\n") {
          if (/^y(?:es)?$/i.test(confirmation.answer.trim())) send({ type: "takeover", turnId: confirmation.turnId, confirm: true });
          confirmation = null; stdout.write("\r\n"); break;
        }
        if (char === "\x7f" || char === "\b") { confirmation.answer = confirmation.answer.slice(0, -1); stdout.write("\b \b"); }
        else if (/^[a-z ]$/i.test(char) && confirmation.answer.length < 10) { confirmation.answer += char; stdout.write(char); }
      }
      return;
    }
    if (!writer && data.includes(3)) {
      if (!holder) return;
      confirmation = { turnId: holder.turnId, answer: "" };
      stdout.write(`\r\nInterrupt ${clean(holder.name)} and take over? File changes stay. [y/N] `);
    } else if (writer && socket?.readyState === WebSocket.OPEN) socket.send(data, { binary: true });
  };
  const stop = () => { leaving = true; socket?.close(); };
  stdin.setRawMode(true); stdin.resume();
  stdin.on("data", input); stdout.on("resize", resize); process.once("SIGTERM", stop); process.once("SIGINT", stop); process.once("SIGHUP", stop);
  try {
    do {
      const current = await accessToken(instance);
      const endpoint = new URL(`${current.url}${storyPath(target.projectId, target.storyId)}/session`);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      endpoint.searchParams.set("client_id", clientId);
      let reconnect = false;
      await new Promise((resolve, reject) => {
        socket = new WebSocket(endpoint, { headers: { authorization: `Bearer ${current.access_token}` }, handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024, followRedirects: false });
        socket.once("open", () => { connected = true; resize(); });
        socket.on("message", (bytes, binary) => {
          if (binary) {
            if (stdout.write(bytes) === false) { const blocked = socket; blocked.pause(); stdout.once("drain", () => blocked.resume()); }
            return;
          }
          let message;
          try { message = JSON.parse(bytes.toString()); } catch { return; }
          if (message.type === "holder") {
            const lost = writer && !message.writer;
            writer = message.writer; holder = message.holder;
            if (confirmation && (writer || holder?.turnId !== confirmation.turnId)) { confirmation = null; console.log("\r\nThe holder changed; review it before confirming takeover."); }
            const key = `${holder?.turnId}:${writer}`;
            if (key !== previous) {
              console.log(`\r\n◆ Facility · ${clean(bundle.story.title)} · ${holder ? `${clean(holder.name)}${holder.kind === "facility" ? ` · started by ${clean(holder.trigger ?? "unknown trigger")}` : ""} since ${holder.since}` : "session free"}\r\n${writer ? "Ctrl-] to leave." : "Watching. Ctrl+C to confirm takeover; Ctrl-] to leave."}`);
              previous = key;
            }
            if (lost) { console.log(`\r\n${clean(message.reason ?? "Someone took over. You are watching now.")}`); reporter.state("blocked", message.reason ?? `${holder?.name ?? "Someone"} took over`); }
            else if (message.phase === "done") reporter.state("idle", undefined, message.completedByMerge ? "PR merged" : "Story completed");
            else if (!writer && holder?.kind === "person") reporter.state("idle", undefined, `${holder.name}'s session`);
            else reporter.state(holder?.state ?? "idle", holder?.message);
          } else if (message.type === "events") {
            for (const event of message.events) {
              const line = renderTurnEvent(event); if (line) console.log(`${line}\r`);
              if (["turn.failed", "turn_error", "worker_interrupted", "turn.worker_interrupted"].includes(event.type)) reporter.state("blocked", `Turn failed: ${event.data?.error ?? event.type}`);
              else if (event.type.includes("agent_waiting")) reporter.state("blocked", event.data?.detail ?? "Agent needs a reply");
            }
          } else if (message.type === "agent_state") {
            reporter.state(message.state, message.message);
          } else if (message.type === "session_ended") {
            leaving = true; console.log(`\r\n${clean(message.message)} (${clean(message.reason ?? "ended")})`);
            if (["budget_exceeded", "budget_model_unpriced", "permission_revoked"].includes(message.reason)) exitCode = 1;
            if (message.reason === "budget_exceeded") reporter.state("blocked", "Project budget exhausted; native session closed");
          } else if (["error", "unsupported"].includes(message.type)) console.error(`\r\n${clean(message.message)}`);
        });
        socket.once("error", (error) => {
          if (connected || leaving) { reconnect = !leaving; resolve(); }
          else reject(error);
        });
        socket.once("unexpected-response", (_request, response) => {
          reconnect = [429, 502, 503, 504].includes(response.statusCode);
          if (!reconnect) { leaving = true; exitCode = 1; console.error(`\r\nFacility refused the session (${response.statusCode}); check your login and permissions.`); }
          response.resume(); socket.terminate(); resolve();
        });
        socket.once("close", (code, reason) => {
          reconnect = !leaving && (code !== 1008 || reason.toString().startsWith("Authentication expired"));
          if (!reconnect && !leaving) { exitCode = 1; console.error(`\r\n${clean(reason)}`); }
          resolve();
        });
      });
      if (!reconnect) break;
      writer = false;
      console.log("\r\nConnection lost; reconnecting to the retained native session…");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } while (!leaving);
  } finally {
    socket?.close(); stdin.off("data", input); stdout.off("resize", resize); process.off("SIGTERM", stop); process.off("SIGINT", stop); process.off("SIGHUP", stop);
    stdin.setRawMode(Boolean(wasRaw)); stdin.pause();
    await reporter.release();
  }
  return exitCode;
}

export async function remoteCommand(command, positional, flags) {
  const instance = flags.instance;
  if (command === "attach") return attach(instance, positional[0]);
  if (command === "stories") {
    const stories = await listStories(instance, flags["needs-you"]);
    const holders = new Map();
    for (const projectId of new Set(stories.map((story) => story.project.id))) {
      const projectHolders = {}; let offset = 0;
      do {
        const result = await api(instance, `/v1/projects/${encodeURIComponent(projectId)}/session-holders?offset=${offset}&limit=1000`);
        Object.assign(projectHolders, result.holders); offset = result.next_offset;
      } while (offset !== null && offset !== undefined);
      holders.set(projectId, projectHolders);
    }
    const rows = [];
    for (const story of stories) rows.push({ project: story.project.slug, id: story.id, title: story.title, phase: story.phase, session: { holder: holders.get(story.project.id)?.[story.id] ?? null } });
    if (flags.json) console.log(JSON.stringify(rows));
    else for (const row of rows) console.log(`${row.project} ${row.id} · ${row.title} · ${row.session.holder?.name ?? "free"}`);
    return 0;
  }
  if (command === "new") {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("facility new requires a terminal because it attaches after creation");
    const all = await projects(instance);
    const project = all.find((item) => [item.slug, item.id].includes(positional[0]));
    if (!project) throw new Error("Project not found");
    const ask = positional.slice(1).join(" ");
    const key = `cli-${randomUUID()}`;
    const result = await api(instance, `/v1/projects/${encodeURIComponent(project.id)}/workspace-stories`, { provider: flags.issue ? "github" : "manual", external_id: flags.issue ? `issue:${flags.issue}` : key, message: ask || "Interactive story", title: ask || flags.issue ? undefined : "Interactive story", agent: flags.agent, idempotency_key: key, interactive_only: !ask });
    const auth = await accessToken(instance);
    return attach(instance, `${auth.url}/projects/${project.id}/stories/${result.story.id}`);
  }
  if (command === "preview") {
    const target = await resolveStory(instance, positional[0]);
    const bundle = await api(instance, storyPath(target.projectId, target.storyId));
    const services = bundle.workspace?.environment?.ports ?? [];
    const service = positional[1] ?? services[0]?.service;
    if (!service) throw new Error("Specify a configured preview service");
    const result = await api(instance, `${storyPath(target.projectId, target.storyId)}/preview/${encodeURIComponent(service)}/open`, {});
    console.log(result.url); return 0;
  }
  throw new Error("Unknown remote command");
}
