#!/usr/bin/env node
import { appendFileSync } from "node:fs";

// Hooks never call the control plane or receive a control-plane credential.
// The broker reads this workspace-local journal through the provider boundary.
const directory = process.env.FACILITY_SESSION_DIRECTORY;
if (directory && /^\/workspace\/\.facility\/interactive\/turn_[a-z0-9]+$/.test(directory)) {
  try {
    let input = process.argv[2];
    if (!input) {
      input = "";
      for await (const chunk of process.stdin) {
        input += chunk;
        if (input.length > 65_536) throw new Error("hook input too large");
      }
    }
    const event = JSON.parse(input || "{}");
    const kind = event.hook_event_name ?? event.type;
    const message = String(
      event.message ?? event.last_assistant_message ?? event["last-assistant-message"] ?? "",
    );
    const attention = /<facility-needs-attention>([\s\S]*?)<\/facility-needs-attention>/
      .exec(message)?.[1]
      ?.trim();
    const state =
      kind === "UserPromptSubmit"
        ? "working"
        : attention || ["Notification", "PermissionRequest"].includes(kind)
          ? "blocked"
          : "idle";
    appendFileSync(
      `${directory}/hooks.jsonl`,
      `${JSON.stringify({
        state,
        message: (attention ?? message).slice(0, 4000),
        at: new Date().toISOString(),
      })}\n`,
      { mode: 0o600 },
    );
  } catch {
    // An observation failure must not fail an agent's prompt or permission flow.
  }
}
