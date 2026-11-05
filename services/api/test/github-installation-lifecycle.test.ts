import { describe, expect, it } from "vitest";
import { installationSuspendedAt } from "../src/routes/webhooks.js";

const now = new Date("2026-11-04T12:00:00Z");

describe("GitHub installation lifecycle", () => {
  it("suspends on suspend and on uninstall, and clears on unsuspend", () => {
    expect(
      installationSuspendedAt(
        { action: "suspend", installation: { id: 1, suspended_at: "2026-11-01T08:00:00Z" } },
        now,
      ),
    ).toEqual(new Date("2026-11-01T08:00:00Z"));
    expect(installationSuspendedAt({ action: "deleted", installation: { id: 1 } }, now)).toEqual(
      now,
    );
    expect(
      installationSuspendedAt(
        { action: "unsuspend", installation: { id: 1, suspended_at: null } },
        now,
      ),
    ).toBeNull();
  });

  it("falls back to the action when the payload has no usable suspended_at", () => {
    expect(installationSuspendedAt({ action: "suspend", installation: { id: 1 } }, now)).toEqual(
      now,
    );
    expect(
      installationSuspendedAt(
        { action: "suspend", installation: { id: 1, suspended_at: "not a date" } },
        now,
      ),
    ).toEqual(now);
    expect(installationSuspendedAt({ action: "unsuspend", installation: [] }, now)).toBeNull();
  });

  it("leaves the state alone for other installation actions", () => {
    for (const action of ["created", "new_permissions_accepted", undefined, 7]) {
      expect(installationSuspendedAt({ action, installation: { id: 1 } }, now)).toBeUndefined();
    }
  });
});
