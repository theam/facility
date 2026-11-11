import { describe, expect, it } from "vitest";
import {
  connectedPreviewSubmodules,
  githubSubmoduleRepository,
  previewTreeEntries,
  safePreviewPath,
} from "../src/stories/preview-submodules.js";

const pin = "a".repeat(40);
const entries = [{ mode: "160000", type: "commit", sha: pin, name: "packages/client" }];
const config = (path = "packages/client", url = "../client.git") =>
  `submodule.client.path\n${path}\0submodule.client.url\n${url}\0`;

describe("preview submodule metadata boundary", () => {
  it.each([
    "https://github.com/acme/client.git",
    "git@github.com:acme/client.git",
    "ssh://git@github.com/acme/client.git",
    "../client.git",
  ])("maps %s only to an already connected repository", (url) => {
    expect(githubSubmoduleRepository(url, "acme/parent")).toBe("acme/client");
    expect(
      connectedPreviewSubmodules(
        config(undefined, url),
        entries,
        "acme/parent",
        new Set(["acme/client"]),
      ),
    ).toEqual([{ path: "packages/client", repository: "acme/client", pin }]);
    expect(
      connectedPreviewSubmodules(config(undefined, url), entries, "acme/parent", new Set()),
    ).toEqual([]);
  });

  it.each([
    "file:///tmp/client.git",
    "https://example.test/acme/client.git",
    "https://github.com.evil.test/acme/client.git",
    "https://user:secret@github.com/acme/client.git",
    "https://github.com:444/acme/client.git",
    "ssh://other@github.com/acme/client.git",
    "ext::unexpected-command",
  ])("does not derive a connected source from %s", (url) => {
    expect(githubSubmoduleRepository(url, "acme/parent")).toBeNull();
    expect(
      connectedPreviewSubmodules(
        config(undefined, url),
        entries,
        "acme/parent",
        new Set(["acme/client"]),
      ),
    ).toEqual([]);
  });

  it.each([
    "",
    "/outside",
    "../outside",
    "a/../outside",
    "a//client",
    "a/./client",
    "a/.GiT/config",
    "a\\client",
    "a\nclient",
    "a\0client",
  ])("rejects unsafe path %j", (path) => {
    expect(safePreviewPath(path)).toBe(false);
    expect(() =>
      connectedPreviewSubmodules(config(path), entries, "acme/parent", new Set(["acme/client"])),
    ).toThrow();
  });

  it("rejects duplicate or ambiguous relationships instead of selecting one", () => {
    for (const extra of [
      "submodule.client.url\nhttps://github.com/acme/other.git\0",
      "submodule.second.path\npackages/client\0submodule.second.url\n../client.git\0",
    ]) {
      expect(() =>
        connectedPreviewSubmodules(
          config() + extra,
          entries,
          "acme/parent",
          new Set(["acme/client"]),
        ),
      ).toThrow();
    }
  });

  it("requires the declared path to be a gitlink in the exact candidate tree", () => {
    expect(() =>
      connectedPreviewSubmodules(config(), [], "acme/parent", new Set(["acme/client"])),
    ).toThrow();
    expect(() =>
      connectedPreviewSubmodules(
        config(),
        [{ mode: "120000", type: "blob", sha: pin, name: "packages/client" }],
        "acme/parent",
        new Set(["acme/client"]),
      ),
    ).toThrow();
  });

  it("parses NUL-delimited tree records without splitting path whitespace", () => {
    expect(previewTreeEntries(`160000 commit ${pin}\tpackages/client with space\0`)).toEqual([
      { mode: "160000", type: "commit", sha: pin, name: "packages/client with space" },
    ]);
    expect(() => previewTreeEntries("invalid\0")).toThrow();
  });
});
