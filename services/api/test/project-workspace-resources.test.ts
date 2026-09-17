import { describe, expect, it } from "vitest";
import {
  parseProjectManifest,
  projectWorkspaceInput,
} from "../src/workspaces/project-environment.js";

function manifest(resources = "") {
  return parseProjectManifest(`
repositories:
  primary: github.com/acme/app
environment:
  ${resources}
  start: docker compose up -d
  services:
    app:
      port: 3000
`);
}

describe("project workspace resources", () => {
  it("leaves omitted resources unset so existing defaults remain unchanged", () => {
    expect(projectWorkspaceInput(manifest(), "runner:default")).toEqual({
      image: "runner:default",
      ports: [{ service: "app", port: 3000, protocol: "http", websocket: true }],
    });
  });

  it("maps only this project's explicit resources into the runtime contract", () => {
    const configured = manifest("resources: { cpu: 4, memory_mb: 8192 }");
    expect(projectWorkspaceInput(configured, "runner:default").resources).toEqual({
      cpu: 4,
      memoryMb: 8192,
    });
    expect(projectWorkspaceInput(manifest(), "runner:default")).not.toHaveProperty("resources");
  });

  it.each([
    "{ cpu: 0, memory_mb: 8192 }",
    "{ cpu: 1.5, memory_mb: 8192 }",
    "{ cpu: 33, memory_mb: 8192 }",
    "{ cpu: 4, memory_mb: 0 }",
    "{ cpu: 4, memory_mb: 65537 }",
    "{ cpu: 4, memory_mb: 8192.5 }",
    "{ cpu: '4', memory_mb: 8192 }",
    "{ cpu: 4 }",
    "{ memory_mb: 8192 }",
    "{ cpu: 4, memory_mb: 8192, gpu: 1 }",
    "null",
  ])("rejects invalid or incomplete resources: %s", (resources) => {
    expect(() => manifest(`resources: ${resources}`)).toThrow(/project_manifest|resources/);
  });
});
