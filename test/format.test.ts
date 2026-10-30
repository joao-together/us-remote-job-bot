import { callbackDataOf } from "../src/core/telegram/format";
import { describe, expect, it } from "vitest";
import type { Country } from "../src/core/match/rules";
import {
  countriesKeyboard,
  escapeHtml,
  formatJobAlert,
  jobKeyboard,
  linkRow,
  parseCallbackData,
  parseCountryCallback,
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

  it("puts the Mexico banner first for an MX-only job, with no warning when there is no reason", () => {
    const html = formatJobAlert(job({ locationText: "Remote - Mexico", locationClass: "intl", countries: ["MX"] }), NOW);
    const lines = html.split("\n");
    expect(lines[0]).toBe("🇲🇽 <b>MEXICO REMOTE</b>");
    expect(lines[1]).toBe("<b>Senior Engineer</b>");
    expect(html).toContain("📍 Remote - Mexico");
    expect(html).not.toContain("⚠️");
    expect(html).not.toContain("Also open to");
  });

  it.each([
    [["CO"], "🇨🇴 <b>COLOMBIA REMOTE</b>"],
    [["AR"], "🇦🇷 <b>ARGENTINA REMOTE</b>"],
    [["MX", "CO"], "🇲🇽🇨🇴 <b>MEXICO · COLOMBIA REMOTE</b>"],
    [["MX", "CO", "AR"], "🇲🇽🇨🇴🇦🇷 <b>MEXICO · COLOMBIA · ARGENTINA REMOTE</b>"],
    [["UK"], "🇬🇧 <b>UK REMOTE</b>"],
    [["MX", "UK"], "🇲🇽🇬🇧 <b>MEXICO · UK REMOTE</b>"],
    [["CO", "AR", "UK"], "🇨🇴🇦🇷🇬🇧 <b>COLOMBIA · ARGENTINA · UK REMOTE</b>"],
  ] as [Country[], string][])("gives an intl job with countries %j the banner %s", (countries, banner) => {
    const html = formatJobAlert(job({ locationText: "Remote", locationClass: "intl", countries }), NOW);
    expect(html.split("\n")[0]).toBe(banner);
    expect(html).not.toContain("⚠️");
    expect(html).not.toContain("Also open to");
  });

  it("gives a LATAM-wide job the LATAM banner and warning", () => {
    const html = formatJobAlert(
      job({ locationText: "Remote - LATAM", locationClass: "intl", countries: [], latam: true, locationReason: "LATAM — check your country is eligible" }),
      NOW,
    );
    expect(html.split("\n")[0]).toBe("🌎 <b>LATAM REMOTE</b>");
    expect(html).toContain("📍 Remote - LATAM\n⚠️ LATAM — check your country is eligible");
    expect(html).not.toContain("Also open to");
    // Without a stored reason the warning is still shown.
    const bare = formatJobAlert(job({ locationText: "Remote - LATAM", locationClass: "intl", latam: true }), NOW);
    expect(bare).toContain("⚠️ LATAM — check your country is eligible");
  });

  it("gives a Europe/EMEA-wide job the EUROPE/EMEA banner and warning", () => {
    const html = formatJobAlert(
      job({ locationText: "Remote - EMEA", locationClass: "intl", countries: [], emea: true, locationReason: "Europe/EMEA — check UK is eligible" }),
      NOW,
    );
    expect(html.split("\n")[0]).toBe("🇪🇺 <b>EUROPE/EMEA REMOTE</b>");
    expect(html).toContain("📍 Remote - EMEA\n⚠️ Europe/EMEA — check UK is eligible");
    expect(html).not.toContain("LATAM");
    expect(html).not.toContain("Also open to");
    // Without a stored reason the warning is still shown.
    const bare = formatJobAlert(job({ locationText: "Remote - Europe", locationClass: "intl", emea: true }), NOW);
    expect(bare).toContain("⚠️ Europe/EMEA — check UK is eligible");
    expect(bare).not.toContain("LATAM");
  });

  it("combines LATAM and Europe/EMEA when no country is named", () => {
    const html = formatJobAlert(
      job({
        locationText: "Remote - LATAM / EMEA",
        locationClass: "intl",
        countries: [],
        latam: true,
        emea: true,
        locationReason: "LATAM — check your country is eligible; Europe/EMEA — check UK is eligible",
      }),
      NOW,
    );
    expect(html.split("\n")[0]).toBe("🌎🇪🇺 <b>LATAM · EUROPE/EMEA REMOTE</b>");
    expect(html).toContain("⚠️ LATAM — check your country is eligible; Europe/EMEA — check UK is eligible");
    const bare = formatJobAlert(job({ locationText: "x", locationClass: "intl", latam: true, emea: true }), NOW);
    expect(bare).toContain("⚠️ LATAM — check your country is eligible\n⚠️ Europe/EMEA — check UK is eligible");
  });

  it("names Europe/EMEA and the UK as extras on a country banner and on a US alert", () => {
    const mx = formatJobAlert(job({ locationText: "Remote - Mexico / Europe", locationClass: "intl", countries: ["MX"], emea: true }), NOW);
    expect(mx.split("\n")[0]).toBe("🇲🇽 <b>MEXICO REMOTE</b>");
    expect(mx).toContain("Also open to: 🇪🇺 Europe/EMEA");
    expect(mx).not.toContain("⚠️");
    const us = formatJobAlert(job({ locationText: "Remote - US / UK / LATAM", countries: ["US", "MX", "UK"], latam: true }), NOW);
    expect(us.split("\n")[0]).toBe("<b>Senior Engineer</b>");
    expect(us).toContain("Also open to: 🇲🇽 Mexico, 🇬🇧 United Kingdom, 🌎 LATAM");
    expect(formatJobAlert(job({ countries: ["US", "UK"] }), NOW)).toContain("Also open to: 🇬🇧 United Kingdom");
    expect(formatJobAlert(job({ countries: ["US"], emea: true }), NOW)).toContain("Also open to: 🇪🇺 Europe/EMEA");
    expect(formatJobAlert(job({ countries: ["US"], latam: true, emea: true }), NOW)).toContain("Also open to: 🌎 LATAM, 🇪🇺 Europe/EMEA");
  });

  it("names LATAM as an extra on a country banner", () => {
    const html = formatJobAlert(job({ locationText: "Remote - LATAM / Colombia", locationClass: "intl", countries: ["CO"], latam: true }), NOW);
    expect(html.split("\n")[0]).toBe("🇨🇴 <b>COLOMBIA REMOTE</b>");
    expect(html).toContain("Also open to: 🌎 LATAM");
    expect(html).not.toContain("⚠️");
  });

  it("escapes an intl job's title, location and reason", () => {
    const html = formatJobAlert(
      job({ title: "Sr <Dev> & Co", locationText: "Remote <MX> & more", locationClass: "intl", countries: ["MX"], locationReason: "a<b>&c" }),
      NOW,
    );
    expect(html).toContain("<b>Sr &lt;Dev&gt; &amp; Co</b>");
    expect(html).toContain("📍 Remote &lt;MX&gt; &amp; more");
    expect(html).toContain("⚠️ a&lt;b&gt;&amp;c");
  });

  it("adds 'Also open to' with the other countries to a US alert, without a banner", () => {
    const html = formatJobAlert(job({ locationText: "Remote - US / Remote - Mexico / Colombia", countries: ["US", "MX", "CO"] }), NOW);
    expect(html.split("\n")[0]).toBe("<b>Senior Engineer</b>");
    expect(html).toContain("📍 Remote - US / Remote - Mexico / Colombia\nAlso open to: 🇲🇽 Mexico, 🇨🇴 Colombia");
    expect(html).not.toContain("REMOTE</b>");
    expect(html).not.toContain("⚠️");
    const restricted = formatJobAlert(
      job({ locationClass: "us_restricted", locationReason: "Limited to some US states: CA, NY", countries: ["US", "AR"] }),
      NOW,
    );
    expect(restricted).toContain("⚠️ Limited to some US states: CA, NY\nAlso open to: 🇦🇷 Argentina");
    expect(formatJobAlert(job({ countries: ["US"], latam: true }), NOW)).toContain("Also open to: 🌎 LATAM");
    expect(formatJobAlert(job({ countries: ["US"] }), NOW)).not.toContain("Also open to");
    expect(formatJobAlert(job(), NOW)).not.toContain("Mexico");
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
  it("adds a Copy link / Open row for the apply URL", () => {
    const url = "https://jobs.lever.co/acme/123";
    expect(jobKeyboard(42, undefined, { applyUrl: url }).inline_keyboard).toEqual([
      [
        { text: "✅ Applied", callback_data: "a:42" },
        { text: "❌ Skip", callback_data: "s:42" },
      ],
      [
        { text: "📋 Copy link", copy_text: { text: url } },
        { text: "🌐 Open", url },
      ],
    ]);
  });

  it("offers only Open when the URL is longer than Telegram's 256-character copy limit", () => {
    const url = `https://jobs.example.com/${"x".repeat(300)}`;
    expect(linkRow(url)).toEqual([{ text: "🌐 Open", url }]);
  });

  it("adds no link row for missing or non-https URLs", () => {
    expect(linkRow(undefined)).toEqual([]);
    expect(linkRow("http://insecure.example.com/job")).toEqual([]);
    expect(jobKeyboard(42, undefined, { applyUrl: "javascript:alert(1)" }).inline_keyboard).toHaveLength(1);
  });

  it("keeps given extra rows unchanged after Applied/Skip", () => {
    const row = [{ text: "📋 Copy link", copy_text: { text: "https://a.test/j" } }];
    expect(jobKeyboard(42, "applied", { extraRows: [row] }).inline_keyboard[1]).toEqual(row);
  });

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
        expect(new TextEncoder().encode(callbackDataOf(button)!).length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("parseCallbackData", () => {
  it("round-trips keyboard callback data", () => {
    for (const button of jobKeyboard(123).inline_keyboard.flat()) {
      const parsed = parseCallbackData(callbackDataOf(button)!);
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

describe("countriesKeyboard", () => {
  it("shows one toggle per country, checked when selected, with short callback data", () => {
    const kb = countriesKeyboard(["US", "CO"]);
    expect(kb.inline_keyboard.map((row) => row.map((b) => [b.text, callbackDataOf(b)!]))).toEqual([
      [["✅ 🇺🇸 United States", "c:US"], ["⬜ 🇲🇽 Mexico", "c:MX"]],
      [["✅ 🇨🇴 Colombia", "c:CO"], ["⬜ 🇦🇷 Argentina", "c:AR"]],
      [["⬜ 🇬🇧 United Kingdom", "c:UK"]],
    ]);
    expect(countriesKeyboard(["UK"]).inline_keyboard[2]).toEqual([{ text: "✅ 🇬🇧 United Kingdom", callback_data: "c:UK" }]);
    for (const row of kb.inline_keyboard) for (const b of row) expect(new TextEncoder().encode(callbackDataOf(b)!).length).toBeLessThanOrEqual(64);
  });

  it("parses only known country buttons", () => {
    expect(parseCountryCallback("c:CO")).toBe("CO");
    expect(parseCountryCallback("c:AR")).toBe("AR");
    expect(parseCountryCallback("c:UK")).toBe("UK");
    expect(parseCountryCallback("c:GB")).toBeNull();
    expect(parseCountryCallback("c:BR")).toBeNull();
    expect(parseCountryCallback("c:co")).toBeNull();
    expect(parseCountryCallback("a:1")).toBeNull();
    expect(parseCallbackData("c:US")).toBeNull();
  });
});
