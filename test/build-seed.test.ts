import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { adapterFor } from "../src/core/ats/detect";
import type { NormalizedJob } from "../src/core/ats/types";
import {
  buildSeedSql,
  collapseByName,
  dedupeCandidates,
  extractBoardLinks,
  parseFrontMatter,
  rankAndCap,
  resolveCandidate,
  selectValid,
  type ProbeOutcome,
  type ResolvedCandidate,
  type SeedCompany,
} from "../scripts/seed-lib";
import { fakeFetcher, json, on } from "./fake-fetch";

function job(title: string, locationText = "Remote - US", countryCodes = ["US"]): NormalizedJob {
  return { id: title, title, locationText, remote: "yes", countryCodes, applyUrl: "https://example.com/apply" };
}

function company(name: string, softwareJobs: number, usSoftwareJobs = softwareJobs): SeedCompany {
  return { name, ats: "greenhouse", token: name.toLowerCase(), jobs: softwareJobs, softwareJobs, usSoftwareJobs };
}

describe("resolveCandidate", () => {
  it("resolves a Greenhouse careers URL to its token", () => {
    expect(resolveCandidate({ name: "GitLab", source: "t", careersUrl: "https://boards.greenhouse.io/gitlab" })).toEqual({
      ats: "greenhouse",
      token: "gitlab",
    });
  });

  it("leaves custom careers domains unresolved", () => {
    expect(resolveCandidate({ name: "Acme", source: "t", careersUrl: "https://acme.com/careers" })).toBeUndefined();
  });
});

describe("selectValid", () => {
  const acme: ResolvedCandidate = { name: "Acme", source: "t", ref: { ats: "greenhouse", token: "acme" } };

  it("excludes boards whose probe is not found", async () => {
    const fetcher = fakeFetcher(
      on("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () =>
        json({ jobs: [{ id: 1, title: "Senior Software Engineer", location: { name: "Remote - US" }, absolute_url: "https://acme.com/1" }] }),
      ),
    );
    const outcomes: ProbeOutcome[] = [];
    for (const c of [acme, { ...acme, name: "Gone", ref: { ats: "greenhouse" as const, token: "gone" } }]) {
      outcomes.push({ candidate: c, result: await adapterFor("greenhouse").listJobs(c.ref.token, fetcher) });
    }
    expect(outcomes[1]!.result).toMatchObject({ ok: false, kind: "not_found" });
    const valid = selectValid(outcomes);
    expect(valid.map((c) => c.name)).toEqual(["Acme"]);
  });

  it("excludes boards with no software roles and counts jobs", () => {
    const valid = selectValid([
      { candidate: acme, result: { ok: true, value: [job("Senior Software Engineer"), job("Backend Engineer", "Berlin, Germany", ["DE"]), job("Account Executive")] } },
      { candidate: { ...acme, name: "Sales Co" }, result: { ok: true, value: [job("Account Executive")] } },
      { candidate: { ...acme, name: "Down" }, result: { ok: false, kind: "http_error", message: "HTTP 500" } },
    ]);
    expect(valid).toEqual([{ name: "Acme", ats: "greenhouse", token: "acme", jobs: 3, softwareJobs: 2, usSoftwareJobs: 1 }]);
  });
});

describe("dedupeCandidates", () => {
  it("collapses the same board type and token across sources", () => {
    const list = dedupeCandidates([
      { name: "Ramp", source: "extra", ref: { ats: "ashby", token: "ramp" } },
      { name: "Ramp Inc", source: "remoteintech:ramp", ref: { ats: "ashby", token: "Ramp" } },
      { name: "Ramp", source: "other", ref: { ats: "lever", token: "ramp" } },
    ]);
    expect(list.map((c) => `${c.source}:${c.ref.ats}`)).toEqual(["extra:ashby", "other:lever"]);
  });

  it("collapseByName keeps the board with more software jobs", () => {
    const old = { ...company("Acme", 2), ats: "lever" as const };
    expect(collapseByName([old, company("Acme", 5)])).toEqual([company("Acme", 5)]);
  });
});

describe("buildSeedSql", () => {
  it("is idempotent text and escapes quotes", () => {
    const sql = buildSeedSql([{ ...company("O'Reilly", 3), token: "oreilly" }], 1_700_000_000_000);
    expect(sql).toBe(
      "INSERT INTO companies (name, ats, board_token, state, baselined, consecutive_failures, created_at) VALUES ('O''Reilly', 'greenhouse', 'oreilly', 'active', 0, 0, 1700000000000) ON CONFLICT(ats, board_token) DO NOTHING;\n",
    );
    expect(buildSeedSql([company("A", 1)], 1)).toBe(buildSeedSql([company("A", 1)], 1));
  });

  it("applies twice without duplicating companies", async () => {
    const db = env.DB;
    const sql = buildSeedSql([company("Seed'Co", 2), company("Other", 1)], 1);
    const statements = sql.trim().split("\n").map((s) => db.prepare(s));
    await db.batch(statements);
    await db.batch(statements);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM companies WHERE board_token IN ('seed''co', 'other') AND state = 'active' AND baselined = 0").first<{ n: number }>();
    expect(row?.n).toBe(2);
  });
});

describe("extractBoardLinks", () => {
  it("finds board links in careers HTML, most frequent first", () => {
    const html = `
      <a href="https://jobs.lever.co/acme/123">Job</a>
      <script src="https://boards.greenhouse.io/embed/job_board/js?for=acmeco&amp;b=x"></script>
      <div data-src="//boards.greenhouse.io/embed/job_board?for=acmeco"></div>
      <iframe src="https://jobs.ashbyhq.com/acme-ai/embed"></iframe>
      fetch("https:\\/\\/api.lever.co\\/v0\\/postings\\/acme?mode=json")
      <a href="https://boards-api.greenhouse.io/v1/boards/acmeco/jobs">api</a>
      <a href="https://www.workable.com/">powered by</a>`;
    expect(extractBoardLinks(html)).toEqual([
      { ats: "greenhouse", token: "acmeco" },
      { ats: "lever", token: "acme" },
      { ats: "ashby", token: "acme-ai" },
    ]);
  });

  it("returns nothing for pages without board links", () => {
    expect(extractBoardLinks("<html><a href='https://greenhouse.io/'>x</a></html>")).toEqual([]);
  });
});

describe("rankAndCap", () => {
  it("keeps the top N by software jobs, sorted by name", () => {
    const list = [company("Zeta", 9), company("Alpha", 1), company("Beta", 5), company("Gamma", 5, 0)];
    expect(rankAndCap(list, 2).map((c) => c.name)).toEqual(["Beta", "Zeta"]);
  });
});

describe("parseFrontMatter", () => {
  it("reads scalar keys", () => {
    const md = `---\ntitle: "GitLab"\nslug: gitlab\ncareers_url: https://about.gitlab.com/jobs/\ntechnologies:\n  - ruby\n---\nbody`;
    expect(parseFrontMatter(md)).toEqual({ title: "GitLab", slug: "gitlab", careers_url: "https://about.gitlab.com/jobs/" });
  });
});
