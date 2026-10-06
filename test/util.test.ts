import { describe, expect, it } from "vitest";
import { atsNameList } from "../src/core/ats/types";
import { errorMessage, redactSecrets } from "../src/core/util";

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
});
