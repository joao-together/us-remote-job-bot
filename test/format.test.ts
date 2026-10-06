import { describe, expect, it } from "vitest";
import {
  escapeHtml,
  formatJobAlert,
  jobKeyboard,
  parseCallbackData,
  type JobAlert,
} from "../src/core/telegram/format";

const NOW = Date.parse("2026-10-06T12:00:00Z");
const HOUR = 60 * 60 * 1000;

function job(overrides: Partial<JobAlert> = {}): JobAlert {
  return {
    title: "Senior Engineer",
    companyName: "Acme",
    locationText: "Remote - US",
    locationClass: "us",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/123",
    ...overrides,
  };
}

describe("escapeHtml", () => {
  it("escapes &, <, > and double quotes", () => {
    expect(escapeHtml(`a & b <c> "d"`)).toBe("a &amp; b &lt;c&gt; &quot;d&quot;");
  });
});

describe("formatJobAlert", () => {
  it("escapes a title containing < and &", () => {
    const html = formatJobAlert(job({ title: "R&D <Platform> Engineer" }), NOW);
    expect(html).toContain("<b>R&amp;D &lt;Platform&gt; Engineer</b>");
    expect(html).not.toContain("<Platform>");
  });

  it("renders company, location, salary, posted-ago and the apply link", () => {
    const html = formatJobAlert(
      job({ salaryText: "$150k – $180k", postedAt: NOW - 3 * HOUR }),
      NOW,
    );
    expect(html).toContain("🏢 Acme");
    expect(html).toContain("📍 Remote - US");
    expect(html).toContain("💰 $150k – $180k");
    expect(html).toContain("🕒 posted 3h ago");
    expect(html).toContain('<a href="https://boards.greenhouse.io/acme/jobs/123">Apply</a>');
    expect(html).toContain("🔗 https://boards.greenhouse.io/acme/jobs/123");
    expect(html).not.toContain("⚠️");
  });

  it("omits the salary line when salary is missing", () => {
    expect(formatJobAlert(job(), NOW)).not.toContain("💰");
    expect(formatJobAlert(job({ salaryText: "  " }), NOW)).not.toContain("💰");
  });

  it("shows ⚠️ and the reason for an ambiguous location", () => {
    const html = formatJobAlert(
      job({ locationText: "Remote", locationClass: "ambiguous", locationReason: "No country stated" }),
      NOW,
    );
    expect(html).toContain("📍 Remote");
    expect(html).toContain("⚠️ No country stated");
  });

  it("shows ⚠️ for a US-restricted location", () => {
    const html = formatJobAlert(
      job({ locationClass: "us_restricted", locationReason: "Only CA, NY & TX" }),
      NOW,
    );
    expect(html).toContain("⚠️ Only CA, NY &amp; TX");
  });

  it("shows no posted-ago for an old (2021) Ashby date", () => {
    const html = formatJobAlert(job({ postedAt: Date.parse("2021-03-01T00:00:00Z") }), NOW);
    expect(html).not.toContain("posted");
  });

  it("shows no posted-ago for a future date or unknown date", () => {
    expect(formatJobAlert(job({ postedAt: NOW + HOUR }), NOW)).not.toContain("posted");
    expect(formatJobAlert(job(), NOW)).not.toContain("posted");
  });

  it("formats minutes, hours and days", () => {
    expect(formatJobAlert(job({ postedAt: NOW - 5 * 60_000 }), NOW)).toContain("posted 5m ago");
    expect(formatJobAlert(job({ postedAt: NOW - 10_000 }), NOW)).toContain("posted 1m ago");
    expect(formatJobAlert(job({ postedAt: NOW - 23 * HOUR }), NOW)).toContain("posted 23h ago");
    expect(formatJobAlert(job({ postedAt: NOW - 50 * HOUR }), NOW)).toContain("posted 2d ago");
    expect(formatJobAlert(job({ postedAt: NOW - 29 * 24 * HOUR }), NOW)).toContain("posted 29d ago");
  });

  it("escapes quotes in the apply URL href", () => {
    const html = formatJobAlert(job({ applyUrl: 'https://x.test/a?b="c"&d=1' }), NOW);
    expect(html).toContain('<a href="https://x.test/a?b=&quot;c&quot;&amp;d=1">Apply</a>');
  });

  it("truncates very long fields and stays under 4096 characters", () => {
    const long = "x&".repeat(2500);
    const html = formatJobAlert(
      job({
        title: long,
        companyName: long,
        locationText: long,
        locationClass: "ambiguous",
        locationReason: long,
        salaryText: long,
      }),
      NOW,
    );
    expect(html.length).toBeLessThan(4096);
    expect(html).toContain("…");
  });

  it("keeps the full href but shortens the visible text of a huge apply URL", () => {
    const url = `https://x.test/${"y".repeat(3000)}`;
    const html = formatJobAlert(job({ applyUrl: url }), NOW);
    expect(html).toContain(`href="${url}"`);
    const visibleText = html.replace(/<[^>]+>/g, "");
    expect(visibleText.length).toBeLessThan(4096);
    expect(visibleText).not.toContain(url);
  });

  it("never includes a description", () => {
    const withDescription = { ...job(), description: "SECRET DESCRIPTION" } as JobAlert;
    expect(formatJobAlert(withDescription, NOW)).not.toContain("SECRET");
  });
});

describe("jobKeyboard", () => {
  it("shows Applied / Skip initially", () => {
    expect(jobKeyboard(42)).toEqual({
      inline_keyboard: [[
        { text: "✅ Applied", callback_data: "a:42" },
        { text: "❌ Skip", callback_data: "s:42" },
      ]],
    });
  });

  it("shows the chosen state plus the opposite option", () => {
    expect(jobKeyboard(42, "applied").inline_keyboard).toEqual([[
      { text: "✅ Applied ✓", callback_data: "a:42" },
      { text: "↩️ Mark skipped", callback_data: "s:42" },
    ]]);
    expect(jobKeyboard(42, "skipped").inline_keyboard).toEqual([[
      { text: "❌ Skipped ✓", callback_data: "s:42" },
      { text: "↩️ Mark applied", callback_data: "a:42" },
    ]]);
  });

  it("keeps callback data under 64 bytes", () => {
    for (const action of [undefined, "applied", "skipped"] as const) {
      for (const button of jobKeyboard(Number.MAX_SAFE_INTEGER, action).inline_keyboard.flat()) {
        expect(new TextEncoder().encode(button.callback_data).length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("parseCallbackData", () => {
  it("round-trips keyboard callback data", () => {
    for (const button of jobKeyboard(123).inline_keyboard.flat()) {
      const parsed = parseCallbackData(button.callback_data);
      expect(parsed?.jobId).toBe(123);
    }
    expect(parseCallbackData("a:123")).toEqual({ action: "applied", jobId: 123 });
    expect(parseCallbackData("s:7")).toEqual({ action: "skipped", jobId: 7 });
  });

  it.each(["a:", "x:1", "a:-1", "a:1e3", "a:0", "a:01", "a:1.5", " a:1", "a:1 ", "a:1:2", "", "a:99999999999999999"])(
    "rejects malformed data %j",
    (data) => {
      expect(parseCallbackData(data)).toBeNull();
    },
  );
});
