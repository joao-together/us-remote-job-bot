import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Store } from "../src/core/store/db";
import { bindingDriver } from "../src/core/store/driver-binding";

/** Re-runs 0008's statements (the migration itself already ran on the empty test DB). */
async function runMigration() {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0008"));
  if (!m) throw new Error("0008 migration not found");
  expect(m.queries.length).toBeGreaterThan(0);
  for (const q of m.queries) await env.DB.prepare(q).run();
}

async function prefs(): Promise<Record<string, string>> {
  const rows = await env.DB.prepare("SELECT user_id, countries FROM user_prefs ORDER BY user_id").all<{ user_id: string; countries: string }>();
  return Object.fromEntries(rows.results.map((r) => [r.user_id, r.countries]));
}

describe("migration 0008 (UK on for everyone)", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM user_prefs").run();
  });

  it("adds UK to every stored selection once, leaving rows that already have it alone", async () => {
    await env.DB.batch(
      [
        ["1", "US"],
        ["2", "US,CO"],
        ["3", "MX,CO,AR"],
        ["4", "US,UK"],
        ["5", "UK,US"],
        ["6", "US,MX,CO,AR,UK"],
      ].map(([id, c]) => env.DB.prepare("INSERT INTO user_prefs (user_id, countries) VALUES (?, ?)").bind(id, c)),
    );

    await runMigration();
    const after = await prefs();
    expect(after).toEqual({
      "1": "US,UK",
      "2": "US,CO,UK",
      "3": "MX,CO,AR,UK",
      "4": "US,UK",
      "5": "UK,US",
      "6": "US,MX,CO,AR,UK",
    });

    // Re-running changes nothing.
    await runMigration();
    expect(await prefs()).toEqual(after);

    // The store reads every resulting value, in COUNTRIES order whatever the stored order.
    const store = new Store(bindingDriver(env.DB), () => 0);
    expect(await store.getUserCountries("1")).toEqual(["US", "UK"]);
    expect(await store.getUserCountries("3")).toEqual(["MX", "CO", "AR", "UK"]);
    expect(await store.getUserCountries("5")).toEqual(["US", "UK"]);
    // No row: every country, UK included.
    expect(await store.getUserCountries("999")).toEqual(["US", "MX", "CO", "AR", "UK"]);
  });

  it("does nothing on an empty table", async () => {
    await runMigration();
    expect(await prefs()).toEqual({});
  });
});
