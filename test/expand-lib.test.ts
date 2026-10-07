import { describe, expect, it } from "vitest";
import type { FetchResult, NormalizedJob } from "../src/core/ats/types";
import {
  atsFromListPath,
  buildCandidates,
  countByAts,
  displayName,
  envNumber,
  interleave,
  mapPoolWithDeadline,
  parseTokenList,
  qualify,
  rankQualified,
  selectToInsert,
  slotsToFill,
  type ExpandCandidate,
  type ExpandProbe,
  type QualifiedCompany,
} from "../scripts/expand-lib";

function job(title: string, locationText = "Remote - US"): NormalizedJob {
  return { id: title, title, locationText, remote: "yes", countryCodes: [], applyUrl: "https://example.com/apply" };
}

function probe(token: string, result: FetchResult<NormalizedJob[]>, name?: string): ExpandProbe {
  return { candidate: { ats: "greenhouse", token, name, source: "t" }, result };
}

function q(name: string, passing: number, jobs = passing, ats: QualifiedCompany["ats"] = "lever"): QualifiedCompany {
  return { name, ats, token: name.toLowerCase().replace(/\s+/g, "-"), source: "t", jobs, passing };
}

describe("parseTokenList", () => {
  it("reads a plain token array and drops invalid or reserved tokens", () => {
    expect(parseTokenList(["acme", "Beta_Co", "bad token", "api", "", 42, null, "a/b"])).toEqual([
      { token: "acme", name: undefined },
      { token: "Beta_Co", name: undefined },
      { token: "42", name: undefined },
    ]);
  });

  it("reads objects with token and name fields", () => {
    expect(
      parseTokenList([
        { token: "acme", name: "Acme Corp" },
        { slug: "beta", company: "  Beta   Inc " },
        { board_token: "gamma" },
        { name: "no token" },
      ]),
    ).toEqual([
      { token: "acme", name: "Acme Corp" },
      { token: "beta", name: "Beta Inc" },
      { token: "gamma", name: undefined },
    ]);
  });

  it("reads a token-keyed object and a wrapped array", () => {
    expect(parseTokenList({ acme: "Acme", beta: { name: "Beta" }, gamma: 1 })).toEqual([
      { token: "acme", name: "Acme" },
      { token: "beta", name: "Beta" },
      { token: "gamma", name: undefined },
    ]);
    expect(parseTokenList({ companies: ["acme"] })).toEqual([{ token: "acme", name: undefined }]);
    expect(parseTokenList("nope")).toEqual([]);
  });
});

describe("atsFromListPath", () => {
  it("maps list files to supported board types only", () => {
    expect(atsFromListPath("data/greenhouse_companies.json")).toBe("greenhouse");
    expect(atsFromListPath("data/lever_companies.json")).toBe("lever");
    expect(atsFromListPath("data/ashby_companies.json")).toBe("ashby");
    expect(atsFromListPath("data/workday_companies.json")).toBeUndefined();
    expect(atsFromListPath("data/greenhouse_companies.csv")).toBeUndefined();
  });
});

describe("buildCandidates", () => {
  const existing = [
    { name: "GitLab", ats: "greenhouse" as const, boardToken: "gitlab" },
    { name: "Old Co", ats: "lever" as const, boardToken: "OldCo" },
  ];

  it("dedupes boards case-insensitively and skips boards already in the DB", () => {
    const a: ExpandCandidate[] = [
      { ats: "lever", token: "Acme", source: "a" },
      { ats: "lever", token: "oldco", source: "a" },
    ];
    const b: ExpandCandidate[] = [
      { ats: "lever", token: "acme", name: "Acme Inc", source: "b" },
      { ats: "ashby", token: "acme", source: "b" },
      { ats: "greenhouse", token: "GITLAB", source: "b" },
      { ats: "ashby", token: "beta", source: "b" },
    ];
    expect(buildCandidates([a, b], existing)).toEqual([
      { ats: "lever", token: "Acme", name: "Acme Inc", source: "a" },
      { ats: "ashby", token: "acme", source: "b" },
      { ats: "ashby", token: "beta", source: "b" },
    ]);
  });

  it("skips a company already watched on another board type, by token or name", () => {
    const list: ExpandCandidate[] = [
      { ats: "ashby", token: "gitlab", source: "x" },
      { ats: "ashby", token: "gl", name: "GitLab", source: "x" },
      { ats: "ashby", token: "old-co", source: "x" },
      { ats: "ashby", token: "new", source: "x" },
    ];
    expect(buildCandidates([list], existing).map((c) => c.token)).toEqual(["new"]);
  });

  it("interleaves lists so each board type gets probed early", () => {
    expect(interleave<number | string>([[1, 2, 3], ["a"], [10, 20]])).toEqual([1, "a", 10, 2, 20, 3]);
    expect(interleave([])).toEqual([]);
  });
});

describe("qualify", () => {
  it("keeps boards with at least one open job passing the rules", () => {
    const probes = [
      probe("acme", { ok: true, value: [job("Senior Backend Engineer"), job("Staff SRE"), job("Recruiter")] }, "Acme"),
      probe("onsite", { ok: true, value: [job("Senior Backend Engineer", "Austin, TX (On-site)")] }),
      probe("junior", { ok: true, value: [job("Junior Software Engineer")] }),
      probe("empty", { ok: true, value: [] }),
      probe("dead", { ok: false, kind: "not_found", message: "404" }),
      probe("data-co", { ok: true, value: [job("Data Engineer"), job("Sales Engineer")] }),
    ];
    expect(qualify(probes)).toEqual([
      { name: "Acme", ats: "greenhouse", token: "acme", source: "t", jobs: 3, passing: 2 },
      { name: "Data Co", ats: "greenhouse", token: "data-co", source: "t", jobs: 2, passing: 1 },
    ]);
  });
});

describe("ranking and cap", () => {
  it("ranks by passing jobs, then open jobs, then name, one board per company", () => {
    const ranked = rankQualified([
      q("Small", 1),
      q("Big", 9, 20),
      q("Mid B", 4, 10),
      q("Mid A", 4, 10),
      q("Mid C", 4, 30),
      q("Big", 3, 5, "ashby"),
    ]);
    expect(ranked.map((c) => `${c.name}:${c.ats}`)).toEqual(["Big:lever", "Mid C:lever", "Mid A:lever", "Mid B:lever", "Small:lever"]);
  });

  it("fills only the slots left to the target", () => {
    const list = [q("A", 5), q("B", 3), q("C", 1)];
    expect(slotsToFill(998, 1000)).toBe(2);
    expect(slotsToFill(1200, 1000)).toBe(0);
    expect(selectToInsert(list, 998, 1000).map((c) => c.name)).toEqual(["A", "B"]);
    expect(selectToInsert(list, 1000, 1000)).toEqual([]);
    expect(selectToInsert(list, 0, 1000)).toHaveLength(3);
  });

  it("counts per board type", () => {
    expect(countByAts([q("A", 1), q("B", 1, 1, "ashby"), q("C", 1)])).toEqual({ lever: 2, ashby: 1 });
  });
});

describe("displayName", () => {
  it.each([
    ["a-place-for-mom", undefined, "A Place For Mom"],
    ["acme", undefined, "Acme"],
    ["acme-inc", undefined, "Acme"],
    ["10up-2", undefined, "10up"],
    ["1password", undefined, "1password"],
    ["scale_ai", undefined, "Scale AI"],
    ["18c78c4427514cebaa7039bbf8a8c249", undefined, "18c78c4427514cebaa7039bbf8a8c249"],
    ["acme", "  Acme   Corp ", "Acme Corp"],
    ["acme", "   ", "Acme"],
  ])("%s / %j -> %s", (token, name, expected) => {
    expect(displayName(token, name)).toBe(expected);
  });
});

describe("mapPoolWithDeadline", () => {
  it("stops starting new items after the deadline and reports it", async () => {
    let clock = 0;
    const { results, stoppedEarly } = await mapPoolWithDeadline([1, 2, 3, 4, 5], 2, 3, () => clock, async (n) => {
      clock++;
      return n * 10;
    });
    expect(stoppedEarly).toBe(true);
    expect(results).toEqual([10, 20, 30]);
  });

  it("finishes everything within the budget", async () => {
    const { results, stoppedEarly } = await mapPoolWithDeadline([1, 2, 3], 16, 100, () => 0, async (n) => n);
    expect(stoppedEarly).toBe(false);
    expect(results).toEqual([1, 2, 3]);
  });
});

describe("envNumber", () => {
  it("accepts positive numbers and falls back otherwise", () => {
    expect(envNumber("1200", 1000)).toBe(1200);
    expect(envNumber(undefined, 1000)).toBe(1000);
    expect(envNumber("", 1000)).toBe(1000);
    expect(envNumber("abc", 25)).toBe(25);
    expect(envNumber("-5", 25)).toBe(25);
  });
});
