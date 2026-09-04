#!/usr/bin/env node

let credentials;
try {
  credentials = JSON.parse(process.env.FACILITY_GITHUB_CREDENTIALS ?? "{}");
} catch {
  process.exit(1);
}
if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) process.exit(1);

let input = "";
for await (const chunk of process.stdin) input += chunk;
const fields = Object.fromEntries(
  input
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf("=");
      return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
    }),
);
if (fields.host !== "github.com") process.exit(0);
const repository = String(fields.path ?? "")
  .replace(/^\/+|\.git$/g, "")
  .toLowerCase();
const token = credentials[repository];
if (typeof token !== "string" || token.length === 0) process.exit(0);
process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
