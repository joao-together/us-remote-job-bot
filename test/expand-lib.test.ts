import { describe, expect, it } from "vitest";
import type { FetchResult, NormalizedJob } from "../src/core/ats/types";
import { DEMOTE_AFTER_MS } from "../src/core/config";
import {
  atsFromListPath,
  buildCandidates,
  classifyProbes,
  countByAts,
  displayName,
  envNumber,
  interleave,
  mapPoolWithDeadline,
  parseTokenList,
  qualify,
  rankQualified,
  selectDemotions,
  selectToInsert,
  shouldDemote,
  slotsToFill,
  type DemotionCandidate,
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

describe("classifyProbes", () => {
  it("sorts live boards into fast (a passing job) and wide (answered OK), and counts dead and failed boards", () => {
    const probes = [
      probe("acme", { ok: true, value: [job("Senior Backend Engineer"), job("Staff SRE"), job("Recruiter")] }, "Acme"),
      probe("onsite", { ok: true, value: [job("Senior Backend Engineer", "Austin, TX (On-site)")] }),
      probe("junior", { ok: true, value: [job("Junior Software Engineer")] }),
      probe("empty", { ok: true, value: [] }),
      probe("dead", { ok: false, kind: "not_found", message: "404" }),
      probe("dead-too", { ok: false, kind: "not_found", message: "Lever site not found" }),
      probe("slow", { ok: false, kind: "timeout", message: "timed out" }),
      probe("broken", { ok: false, kind: "http_error", message: "HTTP 500" }),
      probe("data-co", { ok: true, value: [job("Data Engineer"), job("Sales Engineer")] }),
    ];
    const { boards, dead, failed } = classifyProbes(probes);
    expect(dead).toBe(2);
    expect(failed).toBe(2);
    expect(boards.map((b) => [b.token, b.tier, b.passing, b.jobs])).toEqual([
      ["acme", "fast", 2, 3],
      ["data-co", "fast", 1, 2],
      ["junior", "wide", 0, 1],
      ["onsite", "wide", 0, 1],
      ["empty", "wide", 0, 0],
    ]);
    expect(boards[0]).toMatchObject({ name: "Acme", ats: "greenhouse", source: "t" });
  });

  it("keeps one board per company, preferring the one with passing jobs", () => {
    const { boards } = classifyProbes([
      { candidate: { ats: "lever", token: "acme", name: "Acme", source: "t" }, result: { ok: true, value: [] } },
      { candidate: { ats: "ashby", token: "acme", name: "Acme", source: "t" }, result: { ok: true, value: [job("Senior Backend Engineer")] } },
    ]);
    expect(boards.map((b) => `${b.ats}:${b.tier}`)).toEqual(["ashby:fast"]);
  });

  it("adds every live board when there is no target (Infinity), fast first", () => {
    const { boards } = classifyProbes([
      probe("w1", { ok: true, value: [] }),
      probe("f1", { ok: true, value: [job("Senior Backend Engineer")] }),
      probe("w2", { ok: true, value: [job("Recruiter")] }),
    ]);
    expect(slotsToFill(9000, Infinity)).toBe(Infinity);
    expect(selectToInsert(boards, 9000, Infinity).map((b) => `${b.token}:${b.tier}`)).toEqual(["f1:fast", "w2:wide", "w1:wide"]);
    expect(selectToInsert(boards, 9000, 9001).map((b) => b.token)).toEqual(["f1"]);
    expect(envNumber(undefined, Infinity)).toBe(Infinity);
    expect(envNumber("", Infinity)).toBe(Infinity);
    expect(envNumber("1500", Infinity)).toBe(1500);
  });
});

describe("demotion", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = Date.UTC(2026, 9, 12, 6, 0, 0);
  const co = (o: Partial<DemotionCandidate> = {}): DemotionCandidate => ({
    id: 1,
    state: "active",
    tier: "fast",
    lastMatchAt: null,
    createdAt: NOW - 60 * DAY,
    ...o,
  });

  it("demotes an old fast company that never matched or whose last match is over 30 days old", () => {
    expect(DEMOTE_AFTER_MS).toBe(30 * DAY);
    expect(shouldDemote(co(), NOW)).toBe(true);
    expect(shouldDemote(co({ lastMatchAt: NOW - 31 * DAY }), NOW)).toBe(true);
  });

  it("keeps a company that matched within 30 days", () => {
    expect(shouldDemote(co({ lastMatchAt: NOW - 29 * DAY }), NOW)).toBe(false);
    expect(shouldDemote(co({ lastMatchAt: NOW - 30 * DAY }), NOW)).toBe(false);
    expect(shouldDemote(co({ lastMatchAt: NOW - 1000 }), NOW)).toBe(false);
  });

  it("keeps a company added within 30 days, even with no match yet", () => {
    expect(shouldDemote(co({ createdAt: NOW - 10 * DAY }), NOW)).toBe(false);
    expect(shouldDemote(co({ createdAt: NOW - 30 * DAY }), NOW)).toBe(false);
    expect(shouldDemote(co({ createdAt: NOW - 31 * DAY }), NOW)).toBe(true);
  });

  it("only touches active fast companies", () => {
    expect(shouldDemote(co({ tier: "wide" }), NOW)).toBe(false);
    expect(shouldDemote(co({ state: "inactive" }), NOW)).toBe(false);
    expect(shouldDemote(co({ state: "pending_validation" }), NOW)).toBe(false);
  });

  it("selectDemotions returns the ids to move to wide", () => {
    expect(
      selectDemotions(
        [
          co({ id: 1 }),
          co({ id: 2, lastMatchAt: NOW - 2 * DAY }),
          co({ id: 3, createdAt: NOW - 3 * DAY }),
          co({ id: 4, lastMatchAt: NOW - 45 * DAY }),
          co({ id: 5, tier: "wide" }),
        ],
        NOW,
      ),
    ).toEqual([1, 4]);
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
