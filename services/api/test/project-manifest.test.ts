import { describe, expect, it } from "vitest";
import {
  ProjectEnvironmentError,
  parseProjectManifest,
} from "../src/workspaces/project-environment.js";

const manifest = `
repositories:
  primary: github.com/acme/app
environment:
  start: npm run dev
  services:
    app:
      port: 3000
`;

describe("project manifest", () => {
  it("uses the shared schema when defaults are omitted", () => {
    expect(parseProjectManifest(manifest)).toMatchObject({
      version: 1,
      repositories: { related: [] },
      environment: { secrets: [], variables: [], services: { app: { websocket: true } } },
    });
  });

  it("reports malformed and unknown configuration as a project manifest error", () => {
    expect(() => parseProjectManifest(`${manifest}  unknown: true\n`)).toThrow(
      ProjectEnvironmentError,
    );
    expect(() =>
      parseProjectManifest("repositories: [\nenvironment:\n  start: npm run dev\n"),
    ).toThrow(ProjectEnvironmentError);
  });
});
