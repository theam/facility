// Interactive prompts on node:readline. Zero dependencies.
import { createInterface } from "node:readline/promises";
import { bold, dim } from "./ui.mjs";

let rl = null;

function iface() {
  if (!rl) rl = createInterface({ input: process.stdin, output: process.stdout });
  return rl;
}

export function closePrompts() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/** Free-text question with a default. Empty answer returns the default. */
export async function ask(question, defaultValue = "") {
  const suffix = defaultValue ? ` ${dim(`(${defaultValue})`)}` : "";
  const answer = (await questionOrEof(`  ${bold(question)}${suffix} `)).trim();
  return answer || defaultValue;
}

/** Yes/no question. */
export async function confirm(question, defaultYes = true) {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = (await questionOrEof(`  ${bold(question)} ${dim(`[${hint}]`)} `))
    .trim()
    .toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("y");
}

function questionOrEof(question) {
  const readline = iface();
  return new Promise((resolve, reject) => {
    let settled = false;
    const onClose = () => {
      if (!settled) {
        settled = true;
        const error = new Error("Input ended before the prompt was answered.");
        error.code = "prompt_eof";
        reject(error);
      }
    };
    readline.once("close", onClose);
    readline.question(question).then(
      (answer) => {
        if (settled) return;
        settled = true;
        readline.removeListener("close", onClose);
        resolve(answer);
      },
      (error) => {
        if (settled) return;
        settled = true;
        readline.removeListener("close", onClose);
        reject(error);
      },
    );
  });
}
