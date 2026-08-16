import { describe, expect, it } from "vitest";
import { runErrorCode, runErrorPresentation } from "@/components/run/run-error";

describe("runErrorCode", () => {
  it("extracts the runner's JSON fault code", () => {
    expect(runErrorCode('{"code":"checks_not_configured"}')).toBe("checks_not_configured");
  });

  it("still reads the code when the runner appends stderr tail after the JSON", () => {
    expect(
      runErrorCode('{"code":"checks_not_configured"} npm error something\nnpm ERR! exit 1'),
    ).toBe("checks_not_configured");
  });

  it("accepts a bare machine code", () => {
    expect(runErrorCode("checks_not_configured")).toBe("checks_not_configured");
  });

  it("returns null for unknown codes, plain text, and empty errors", () => {
    expect(runErrorCode('{"code":"provision_failed"}')).toBe("provision_failed");
    expect(runErrorCode("the database exploded")).toBeNull();
    expect(runErrorCode('{"message":"not a code"}')).toBeNull();
    expect(runErrorCode("")).toBeNull();
    expect(runErrorCode(null)).toBeNull();
    expect(runErrorCode(undefined)).toBeNull();
  });
});

describe("runErrorPresentation", () => {
  it("maps checks_not_configured to a human explanation with a settings link", () => {
    expect(runErrorPresentation('{"code":"checks_not_configured"}', "project_1")).toEqual({
      code: "checks_not_configured",
      message:
        "No acceptance checks are configured for this project, so the builder run could not deliver.",
      href: "/projects/project_1/settings",
    });
  });

  it("drops the settings link when no project is known", () => {
    expect(runErrorPresentation("checks_not_configured", null)).toMatchObject({ href: null });
  });

  it("leaves unknown errors to the raw renderer", () => {
    expect(runErrorPresentation("error: something broke", "project_1")).toBeNull();
    expect(runErrorPresentation(null, "project_1")).toBeNull();
  });
});
