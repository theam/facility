#!/usr/bin/env node
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const workspaceRoots = ["apps", "packages", "services"];
const workspaces = ["runner"];

for (const root of workspaceRoots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) workspaces.push(join(root, entry.name));
  }
}

for (const workspace of workspaces) {
  if (!existsSync(join(workspace, "package.json"))) continue;
  for (const output of ["dist", "build", ".next"]) {
    const path = join(workspace, output);
    if (!existsSync(path)) continue;
    rmSync(path, { recursive: true, force: true });
    console.log(`removed ${path}`);
  }
}
