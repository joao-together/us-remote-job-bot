import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker, { WEBHOOK_PATH } from "../src/worker/index";

describe("scaffold", () => {
  it("applies migrations", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('companies', 'jobs', 'settings') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((r) => r.name)).toEqual(["companies", "jobs", "settings"]);
  });

  it("returns 404 for paths other than the webhook", async () => {
    const res = await worker.fetch(new Request("https://bot.example/anything"), env);
    expect(res.status).toBe(404);
    expect(WEBHOOK_PATH).toBe("/telegram/webhook");
  });
});
