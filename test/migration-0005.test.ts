import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const T = 1_790_000_000_000;

async function reset() {
  await env.DB.batch(["DELETE FROM deliveries", "DELETE FROM jobs", "DELETE FROM companies"].map((s) => env.DB.prepare(s)));
}

/** Re-runs 0005's data statements (the migration itself already ran on the empty test DB). */
async function runMigrationData() {
  const m = env.TEST_MIGRATIONS.find((x) => x.name.startsWith("0005"));
  if (!m) throw new Error("0005 migration not found");
  for (const q of m.queries) if (!/^\s*CREATE INDEX/i.test(q)) await env.DB.prepare(q).run();
}

async function addJob(companyId: number, boardJobId: string, status: string) {
  await env.DB.prepare(
    `INSERT INTO jobs (company_id, board_job_id, title, normalized_title, apply_url, status, first_seen_at)
     VALUES (?, ?, 't', 't', 'https://x.test', ?, ?)`,
  )
    .bind(companyId, boardJobId, status, T)
    .run();
}

describe("migration 0005", () => {
  beforeEach(reset);

  it("folds legacy seen rows into seen_ids, keeps existing ids and deletes only seen rows", async () => {
    const a = await env.DB.prepare(
      "INSERT INTO companies (name, ats, board_token, state, baselined, created_at, seen_ids) VALUES ('A','lever','a','active',1,?,'[\"x\"]') RETURNING id",
    )
      .bind(T)
      .first<{ id: number }>();
    const b = await env.DB.prepare(
      "INSERT INTO companies (name, ats, board_token, state, baselined, created_at, seen_ids) VALUES ('B','lever','b','active',1,?,'[\"keep\"]') RETURNING id",
    )
      .bind(T)
      .first<{ id: number }>();
    await addJob(a!.id, "s1", "seen");
    await addJob(a!.id, "s2", "seen");
    await addJob(a!.id, "x", "seen");
    await addJob(a!.id, "p1", "sent");

    await runMigrationData();

    const rows = await env.DB.prepare("SELECT id, seen_ids FROM companies ORDER BY id").all<{ id: number; seen_ids: string }>();
    expect((JSON.parse(rows.results[0]!.seen_ids) as string[]).sort()).toEqual(["s1", "s2", "x"]);
    expect(JSON.parse(rows.results[1]!.seen_ids)).toEqual(["keep"]);
    const jobs = await env.DB.prepare("SELECT board_job_id, status FROM jobs").all<{ board_job_id: string; status: string }>();
    expect(jobs.results).toEqual([{ board_job_id: "p1", status: "sent" }]);
    void b;
  });

  it("lets the repost query use the partial index", async () => {
    const plan = await env.DB.prepare(
      `EXPLAIN QUERY PLAN SELECT company_id, board_job_id, normalized_title, location_text FROM jobs
       WHERE company_id IN (?, ?) AND status IN ('sent', 'pending', 'sending') AND first_seen_at >= ?`,
    )
      .bind(1, 2, 0)
      .all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toContain("jobs_repost_recent");
  });
});
