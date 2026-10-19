import { describe, expect, it } from "vitest";
import { atsNameList } from "../src/core/ats/types";
import { ACTIVE_HOURS_UTC } from "../src/core/config";
import { activeWindowStart, errorMessage, inActiveHours, redactSecrets } from "../src/core/util";

describe("util", () => {
  it("redactSecrets replaces every non-empty secret", () => {
    expect(redactSecrets("a TOKEN b TOKEN c KEY", "TOKEN", "", undefined, "KEY")).toBe("a [redacted] b [redacted] c [redacted]");
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });

  it("errorMessage reads Error messages and stringifies the rest", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });

  it("atsNameList builds a human list of board types", () => {
    expect(atsNameList("or")).toBe("Greenhouse, Lever, Ashby or Workable");
    expect(atsNameList("and")).toBe("Greenhouse, Lever, Ashby and Workable");
  });

  it("active hours are 12:00–24:00 UTC (08:00–20:00 US Eastern daylight time)", () => {
    expect(ACTIVE_HOURS_UTC).toEqual({ start: 12, end: 24 });
    const day = Date.UTC(2026, 9, 6);
    const at = (h: number, m = 0) => day + h * 3_600_000 + m * 60_000;
    expect(activeWindowStart(at(11, 59))).toBeUndefined();
    expect(activeWindowStart(at(12))).toBe(at(12));
    expect(activeWindowStart(at(23, 59))).toBe(at(12));
    expect(activeWindowStart(at(24))).toBeUndefined();
    expect(inActiveHours(at(3))).toBe(false);
    expect(inActiveHours(at(18))).toBe(true);
  });
});
