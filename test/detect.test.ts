import { describe, expect, it } from "vitest";
import { adapterFor, parseBoardInput, probeBoard } from "../src/core/ats/detect";
import { ATS_KINDS } from "../src/core/ats/types";
import ashbyBoard from "./fixtures/ashby/job-board.json";
import leverPostings from "./fixtures/lever/postings.json";
import { fakeFetcher, json, on } from "./fake-fetch";

describe("parseBoardInput", () => {
  it.each([
    ["https://boards.greenhouse.io/gitlab", "greenhouse", "gitlab"],
    ["https://boards.greenhouse.io/gitlab/jobs/123?gh_jid=123", "greenhouse", "gitlab"],
    ["https://job-boards.greenhouse.io/gitlab/jobs/8615811002", "greenhouse", "gitlab"],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", "greenhouse", "acme"],
    ["https://jobs.lever.co/spotify", "lever", "spotify"],
    ["https://jobs.lever.co/spotify/4310f31c-90e1-4e8d-bdcf-dce39c145b8c/apply", "lever", "spotify"],
    ["https://jobs.ashbyhq.com/ramp", "ashby", "ramp"],
    ["https://jobs.ashbyhq.com/ramp/c63ba7d7-5290-4d9b-b002-40b2873b66f6", "ashby", "ramp"],
    ["https://apply.workable.com/huggingface/", "workable", "huggingface"],
    ["https://apply.workable.com/huggingface/j/F88446C814/", "workable", "huggingface"],
    ["https://huggingface.workable.com", "workable", "huggingface"],
    ["jobs.lever.co/spotify", "lever", "spotify"],
    ["  HTTPS://JOBS.LEVER.CO/spotify  ", "lever", "spotify"],
  ])("%s -> %s/%s", (input, ats, token) => {
    expect(parseBoardInput(input)).toEqual({ ats, token });
  });

  it("returns a bare safe slug for probing", () => {
    expect(parseBoardInput("acme-co_1")).toEqual({ slug: "acme-co_1" });
  });

  it.each(["acme/jobs", "acme?x=1", "..", "../etc", "acme..", "ac me", "acme%2F", ""])("rejects unsafe slug %j", (input) => {
    expect(parseBoardInput(input)).toHaveProperty("error");
  });

  it("rejects unknown hosts and board URLs without a valid token", () => {
    expect(parseBoardInput("https://example.com/careers")).toHaveProperty("error");
    expect(parseBoardInput("https://example.com/careers?gh_jid=123")).toHaveProperty("error");
    expect(parseBoardInput("https://jobs.lever.co/")).toHaveProperty("error");
    expect(parseBoardInput("https://boards.greenhouse.io/embed/job_board?for=a/../b")).toHaveProperty("error");
    expect(parseBoardInput("https://jobs.ashbyhq.com/%2E%2E")).toHaveProperty("error");
    expect(parseBoardInput("https://www.workable.com/")).toHaveProperty("error");
  });
});

describe("adapterFor", () => {
  it("returns the adapter for each kind", () => {
    for (const kind of ATS_KINDS) expect(adapterFor(kind).kind).toBe(kind);
  });
});

describe("probeBoard", () => {
  const LEVER = "https://api.lever.co/v0/postings/ramp?mode=json";
  const ASHBY = "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true";

  it("rejects an unsafe slug before any request", async () => {
    const f = fakeFetcher();
    for (const slug of ["a/b", "a?b", ".."]) {
      expect(await probeBoard(slug, f)).toMatchObject({ ok: false, kind: "not_found" });
    }
    expect(f.requests).toHaveLength(0);
  });

  it("tries boards in order and returns the first with jobs", async () => {
    const f = fakeFetcher(
      on(LEVER, () => json({ ok: false, error: "Document not found" })),
      on(ASHBY, () => json(ashbyBoard)),
    );
    const res = await probeBoard("ramp", f);
    expect(res.ok && res.value.ref).toEqual({ ats: "ashby", token: "ramp" });
    expect(res.ok && res.value.jobs).toHaveLength(3);
    expect(f.requests.map((r) => new URL(r.url).hostname)).toEqual([
      "boards-api.greenhouse.io",
      "api.lever.co",
      "api.ashbyhq.com",
    ]);
  });

  it("prefers a later board with jobs over an empty Lever board", async () => {
    const f = fakeFetcher(on(LEVER, () => json([])), on(ASHBY, () => json(ashbyBoard)));
    const res = await probeBoard("ramp", f);
    expect(res.ok && res.value.ref.ats).toBe("ashby");
  });

  it("falls back to an empty Lever board when nothing else exists", async () => {
    const f = fakeFetcher(on(LEVER, () => json([])));
    expect(await probeBoard("ramp", f)).toEqual({ ok: true, value: { ref: { ats: "lever", token: "ramp" }, jobs: [] } });
    expect(f.requests).toHaveLength(4);
  });

  it("returns a Lever board with jobs", async () => {
    const f = fakeFetcher(on(LEVER, () => json(leverPostings)));
    const res = await probeBoard("ramp", f);
    expect(res.ok && res.value.ref.ats).toBe("lever");
    expect(res.ok && res.value.jobs).toHaveLength(4);
  });

  it("is not found when no board type matches", async () => {
    expect(await probeBoard("ramp", fakeFetcher())).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("reports a non-404 failure when no board was found", async () => {
    const f = fakeFetcher(on(LEVER, () => new Response("busy", { status: 503 })));
    expect(await probeBoard("ramp", f)).toMatchObject({ ok: false, kind: "http_error" });
  });
});
