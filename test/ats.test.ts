import { describe, expect, it } from "vitest";
import { ashby } from "../src/core/ats/ashby";
import { greenhouse, greenhouseRemote } from "../src/core/ats/greenhouse";
import { fetchJson } from "../src/core/ats/http";
import { lever } from "../src/core/ats/lever";
import { decodeEntities, formatMoneyRange, htmlToText } from "../src/core/ats/text";
import type { FetchResult, NormalizedJob } from "../src/core/ats/types";
import { workable } from "../src/core/ats/workable";
import { USER_AGENT } from "../src/core/config";
import { matchesTarget } from "../src/core/match/rules";
import ashbyBoard from "./fixtures/ashby/job-board.json";
import ghDetailNoPay from "./fixtures/greenhouse/detail-no-pay.json";
import ghDetailPay from "./fixtures/greenhouse/detail-pay.json";
import ghJobs from "./fixtures/greenhouse/jobs.json";
import leverPostings from "./fixtures/lever/postings.json";
import wkDetail from "./fixtures/workable/job-detail.json";
import wkPage1 from "./fixtures/workable/jobs-page1.json";
import wkPage2 from "./fixtures/workable/jobs-page2.json";
import { fakeFetcher, json, on } from "./fake-fetch";

const GH_LIST = "https://boards-api.greenhouse.io/v1/boards/gitlab/jobs";
const LEVER_LIST = "https://api.lever.co/v0/postings/spotify?mode=json";
const ASHBY_LIST = "https://api.ashbyhq.com/posting-api/job-board/ramp?includeCompensation=true";
const WK_LIST = "https://apply.workable.com/api/v3/accounts/huggingface/jobs";

function unwrap<T>(res: FetchResult<T>): T {
  if (!res.ok) throw new Error(`expected ok, got ${res.kind}: ${res.message}`);
  return res.value;
}

function byId(jobs: NormalizedJob[], id: string): NormalizedJob {
  const job = jobs.find((j) => j.id === id);
  if (!job) throw new Error(`job ${id} not emitted`);
  return job;
}

describe("text helpers", () => {
  it("decodes named and numeric entities", () => {
    expect(decodeEntities("a &amp; b &lt;p&gt; &#39;x&#x27; &rsquo; &unknown;")).toBe("a & b <p> 'x' ’ &unknown;");
  });

  it("converts HTML to plain text", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b></p><ul><li>One</li><li>Two</li></ul><script>x()</script>")).toBe(
      "Hello world\n\n- One\n- Two",
    );
  });

  it("formats money ranges", () => {
    expect(formatMoneyRange(170000, 210000, "USD")).toBe("$170,000–$210,000 USD");
    expect(formatMoneyRange(60000, 80000, "eur")).toBe("60,000–80,000 EUR");
    expect(formatMoneyRange(undefined, undefined, "USD")).toBeUndefined();
  });
});

describe("greenhouse", () => {
  const fetcher = () => fakeFetcher(on(GH_LIST, () => json(ghJobs)));

  it("normalizes the list fixture", async () => {
    const jobs = unwrap(await greenhouse.listJobs("gitlab", fetcher()));
    expect(byId(jobs, "8615811002")).toEqual({
      id: "8615811002",
      title: "Director, Strategic Partnerships",
      locationText: "Remote, US",
      remote: "yes",
      countryCodes: ["US"],
      applyUrl: "https://job-boards.greenhouse.io/gitlab/jobs/8615811002",
      postedAt: Date.parse(ghJobs.jobs[0]!.first_published),
    });
    expect(byId(jobs, "8857185002")).toMatchObject({
      title: "Associate Renewals Manager",
      remote: "yes",
      countryCodes: ["CA", "US"],
    });
  });

  it('"Remote - US" is remote yes; "United States" is unknown; hybrid is no', async () => {
    expect(greenhouseRemote("Remote - US")).toBe("yes");
    const jobs = unwrap(await greenhouse.listJobs("gitlab", fetcher()));
    expect(byId(jobs, "8857611002")).toMatchObject({ locationText: "United States", remote: "unknown", countryCodes: ["US"] });
    expect(byId(jobs, "8626772002")).toMatchObject({ locationText: "Bangalore, India", remote: "unknown", countryCodes: ["IN"] });
    expect(byId(jobs, "8859694002")).toMatchObject({ remote: "no" });
    expect(greenhouseRemote("Hybrid - Austin")).toBe("no");
    expect(greenhouseRemote("On-site - Denver")).toBe("no");
  });

  it("mixed remote and hybrid text is unknown so the per-segment classifier decides", async () => {
    expect(greenhouseRemote("Remote (Hybrid), Austin")).toBe("unknown");
    const raw = {
      jobs: [
        {
          id: 1,
          title: "Senior Software Engineer",
          absolute_url: "https://job-boards.greenhouse.io/acme/jobs/1",
          location: { name: "Hybrid - NYC / Remote - US" },
          updated_at: "2026-10-05T16:47:52-04:00",
        },
      ],
    };
    const f = fakeFetcher(on("https://boards-api.greenhouse.io/v1/boards/acme/jobs", () => json(raw)));
    const jobs = unwrap(await greenhouse.listJobs("acme", f));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.remote).toBe("unknown");
    expect(matchesTarget(jobs[0]!).pass).toBe(true);
  });

  it("drops a job whose apply URL is not https", async () => {
    const jobs = unwrap(await greenhouse.listJobs("gitlab", fetcher()));
    expect(jobs.map((j) => j.id)).not.toContain("8698314002");
    expect(jobs).toHaveLength(5);
  });

  it("requests the list without content and with a User-Agent", async () => {
    const f = fetcher();
    await greenhouse.listJobs("gitlab", f);
    expect(f.requests[0]!.url).toBe(GH_LIST);
    expect(f.requests[0]!.headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("detail with pay ranges gives salary text and a plain-text description", async () => {
    const f = fakeFetcher(on(`${GH_LIST}/8860302002?pay_transparency=true`, () => json(ghDetailPay)));
    const detail = unwrap(await greenhouse.fetchDetail!("gitlab", "8860302002", f));
    expect(detail.salaryText).toBe("$170,000–$210,000 USD");
    expect(detail.description).toContain("GitLab is the intelligent orchestration platform for DevSecOps.");
    expect(detail.description).toContain("Benefits & perks included.");
    expect(detail.description).not.toMatch(/<|&lt;|&amp;|&nbsp;/);
  });

  it("detail with empty pay ranges has no salary", async () => {
    const f = fakeFetcher(on(`${GH_LIST}/8860302002?pay_transparency=true`, () => json(ghDetailNoPay)));
    const detail = unwrap(await greenhouse.fetchDetail!("gitlab", "8860302002", f));
    expect(detail.salaryText).toBeUndefined();
    expect(detail.description.length).toBeGreaterThan(50);
  });
});

describe("lever", () => {
  const fetcher = () => fakeFetcher(on(LEVER_LIST, () => json(leverPostings)));

  it("normalizes the fixture", async () => {
    const jobs = unwrap(await lever.listJobs("spotify", fetcher()));
    expect(jobs).toHaveLength(4);
    const remoteUs = byId(jobs, "4310f31c-90e1-4e8d-bdcf-dce39c145b8c");
    expect(remoteUs).toMatchObject({
      title: "Associate – Audiobook Licensing & Author Partnerships",
      locationText: "New York, NY",
      remote: "yes",
      countryCodes: ["US"],
      applyUrl: "https://jobs.lever.co/spotify/4310f31c-90e1-4e8d-bdcf-dce39c145b8c",
      postedAt: 1783608935950,
      salaryText: "$150,000–$190,000 USD/yr",
    });
    expect(byId(jobs, "5992c673-e493-48b1-bb63-9b82a4c31876")).toMatchObject({ remote: "no", countryCodes: ["GB"] });
    expect(byId(jobs, "03437e2a-2d5e-4593-9e97-11271014932e")).toMatchObject({ remote: "yes", countryCodes: ["CA"] });
  });

  it("hybrid workplaceType gives remote no and joins all locations", async () => {
    const jobs = unwrap(await lever.listJobs("spotify", fetcher()));
    expect(byId(jobs, "7aeec299-4653-4c5d-aafb-d537e1232208")).toMatchObject({
      remote: "no",
      locationText: "New York, NY / Stockholm",
    });
  });

  it("carries descriptionPlain on the normalized job", async () => {
    const jobs = unwrap(await lever.listJobs("spotify", fetcher()));
    expect(byId(jobs, "4310f31c-90e1-4e8d-bdcf-dce39c145b8c").description).toContain(leverPostings[0]!.descriptionPlain);
  });

  it("an empty list is a valid empty board", async () => {
    const f = fakeFetcher(on(LEVER_LIST, () => json([])));
    expect(await lever.listJobs("spotify", f)).toEqual({ ok: true, value: [] });
  });

  it('{"ok":false} is not found', async () => {
    const f = fakeFetcher(on(LEVER_LIST, () => json({ ok: false, error: "Document not found" })));
    expect(await lever.listJobs("spotify", f)).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("drops a posting with a non-https URL", async () => {
    const insecure = { ...leverPostings[0]!, hostedUrl: "http://jobs.lever.co/spotify/x", applyUrl: "http://x" };
    const f = fakeFetcher(on(LEVER_LIST, () => json([insecure, leverPostings[1]])));
    const jobs = unwrap(await lever.listJobs("spotify", f));
    expect(jobs.map((j) => j.id)).toEqual([leverPostings[1]!.id]);
  });
});

describe("ashby", () => {
  const fetcher = () => fakeFetcher(on(ASHBY_LIST, () => json(ashbyBoard)));

  it("normalizes the fixture and maps compensation summary to salary", async () => {
    const jobs = unwrap(await ashby.listJobs("ramp", fetcher()));
    const remote = byId(jobs, "c63ba7d7-5290-4d9b-b002-40b2873b66f6");
    expect(remote).toMatchObject({
      title: "Partner Consultant, Accounting",
      locationText: "Remote (US) / Remote (Canada) / San Francisco, CA / New York, NY (HQ)",
      remote: "yes",
      applyUrl: "https://jobs.ashbyhq.com/ramp/c63ba7d7-5290-4d9b-b002-40b2873b66f6",
      salaryText: "$151K – $231K • Offers Equity • Multiple Ranges",
      postedAt: Date.parse("2026-09-02T17:17:20.841+00:00"),
    });
    expect(remote.countryCodes).toEqual(expect.arrayContaining(["US", "CA"]));
    expect(remote.description).toBeTruthy();
    expect(remote.description).not.toMatch(/<\/?[a-z]/i);

    expect(byId(jobs, "34413f8d-26bf-4bbc-8ade-eb309a0e2245")).toMatchObject({
      title: "Security Engineer, Cloud",
      remote: "no",
      salaryText: "$211.4K – $290.6K • Offers Equity",
    });
    expect(byId(jobs, "1515fe6d-1d8e-475b-a5ee-cefe43e78cb7")).toMatchObject({
      remote: "no",
      countryCodes: ["GB"],
      salaryText: undefined,
    });
  });

  it("drops unlisted jobs", async () => {
    const jobs = unwrap(await ashby.listJobs("ramp", fetcher()));
    expect(jobs.map((j) => j.id)).not.toContain("d84bbf19-572a-499c-9c87-0c154ce85caf");
    expect(jobs).toHaveLength(3);
  });

  it("drops a job with a non-https URL", async () => {
    const insecure = { ...ashbyBoard.jobs[0]!, jobUrl: "http://jobs.ashbyhq.com/ramp/x", applyUrl: "http://x" };
    const f = fakeFetcher(on(ASHBY_LIST, () => json({ jobs: [insecure] })));
    expect(await ashby.listJobs("ramp", f)).toEqual({ ok: true, value: [] });
  });
});

describe("workable", () => {
  const fetcher = () =>
    fakeFetcher(
      on(WK_LIST, (req) => json(JSON.parse(req.body ?? "{}").token === wkPage1.nextPage ? wkPage2 : wkPage1), "POST"),
      on(`https://apply.workable.com/api/v2/accounts/huggingface/jobs/F88446C814`, () => json(wkDetail)),
    );

  it("combines two pages via nextPage", async () => {
    const f = fetcher();
    const jobs = unwrap(await workable.listJobs("huggingface", f));
    expect(jobs).toHaveLength(6);
    expect(f.requests.map((r) => r.body)).toEqual(["{}", JSON.stringify({ token: wkPage1.nextPage })]);
    expect(f.requests[0]!.headers.get("content-type")).toBe("application/json");
  });

  it("normalizes remote, location and apply URL", async () => {
    const jobs = unwrap(await workable.listJobs("huggingface", fetcher()));
    expect(byId(jobs, "F88446C814")).toEqual({
      id: "F88446C814",
      title: "Senior Open-Source Python Engineer, ML Developer Tools - US Remote",
      locationText: "United States",
      remote: "yes",
      countryCodes: ["US"],
      applyUrl: "https://apply.workable.com/huggingface/j/F88446C814/",
      postedAt: Date.parse("2026-09-21T00:00:00.000Z"),
    });
    expect(byId(jobs, "9E2A4C02C7")).toMatchObject({ locationText: "Paris, Île-de-France, France", countryCodes: ["FR"] });
    expect(byId(jobs, "0BD8C06DB3")).toMatchObject({ remote: "no" });
  });

  it("fetchDetail returns the description as text", async () => {
    const detail = unwrap(await workable.fetchDetail!("huggingface", "F88446C814", fetcher()));
    expect(detail.description).toContain("At Hugging Face, we're on a journey to democratize good AI.");
    expect(detail.description).not.toMatch(/<\/?[a-z]/i);
    expect(detail.salaryText).toBeUndefined();
  });
});

describe("failures", () => {
  it("404 is not found for every adapter", async () => {
    const f = fakeFetcher();
    for (const adapter of [greenhouse, lever, ashby, workable]) {
      expect(await adapter.listJobs("nope", f)).toMatchObject({ ok: false, kind: "not_found" });
    }
    expect(await greenhouse.fetchDetail!("nope", "1", f)).toMatchObject({ ok: false, kind: "not_found" });
  });

  it("malformed JSON is a parse error, not a throw", async () => {
    const f = fakeFetcher(() => new Response("{not json", { status: 200 }));
    for (const adapter of [greenhouse, lever, ashby, workable]) {
      expect(await adapter.listJobs("acme", f)).toMatchObject({ ok: false, kind: "parse_error" });
    }
  });

  it("an unexpected payload shape is a parse error", async () => {
    const f = fakeFetcher(() => json({ hello: "world" }));
    for (const adapter of [greenhouse, lever, ashby, workable]) {
      expect(await adapter.listJobs("acme", f)).toMatchObject({ ok: false, kind: "parse_error" });
    }
  });

  it("other non-2xx statuses are HTTP errors", async () => {
    const f = fakeFetcher(() => new Response("oops", { status: 503 }));
    expect(await greenhouse.listJobs("acme", f)).toMatchObject({ ok: false, kind: "http_error" });
  });

  it("an aborted request is a timeout", async () => {
    const f = fakeFetcher(() => {
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    for (const adapter of [greenhouse, lever, ashby, workable]) {
      expect(await adapter.listJobs("acme", f)).toMatchObject({ ok: false, kind: "timeout" });
    }
  });

  it("a network error is an HTTP error", async () => {
    const f = fakeFetcher(() => {
      throw new TypeError("fetch failed");
    });
    expect(await fetchJson(f, "https://example.com/x")).toMatchObject({ ok: false, kind: "http_error" });
  });

  it("URL-encodes tokens into request paths", async () => {
    const f = fakeFetcher();
    await greenhouse.listJobs("a/b?c", f);
    expect(f.requests[0]!.url).toBe("https://boards-api.greenhouse.io/v1/boards/a%2Fb%3Fc/jobs");
  });
});
