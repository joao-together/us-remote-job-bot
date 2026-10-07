// Grows the watched company list toward EXPAND_TARGET_TOTAL (default 1000) active companies.
// Probes candidate boards from public lists and adds those with at least one open job passing the
// match rules (evidence of US-remote engineering hiring), best first, as active + unbaselined so the
// poller baselines them silently. Run via the "Expand company list" workflow; `--dry-run` writes nothing.
import path from "node:path";
import { adapterFor } from "../src/core/ats/detect";
import type { AtsKind, Fetcher } from "../src/core/ats/types";
import { USER_AGENT } from "../src/core/config";
import { Store } from "../src/core/store/db";
import { httpDriver } from "../src/core/store/driver-http";
import { errorMessage } from "../src/core/util";
import {
  atsFromListPath,
  buildCandidates,
  countByAts,
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
} from "./expand-lib";
import { nameKey, parseFrontMatter, resolveCandidate } from "./seed-lib";

const startedAt = Date.now();
const dryRun = process.argv.includes("--dry-run") || process.env.EXPAND_DRY_RUN === "true";
const target = envNumber(process.env.EXPAND_TARGET_TOTAL, 1000);
const budgetMin = envNumber(process.env.EXPAND_TIME_BUDGET_MIN, 25);
const deadline = startedAt + budgetMin * 60_000;
const PROBE_CONCURRENCY = 16;
const PROBE_TIMEOUT_MS = 15_000;
const LIST_TIMEOUT_MS = 30_000;

const RIJ_REPO = "remoteintech/remote-jobs";
const AGG_REPO = "Feashliaa/job-board-aggregator";
const AGG_FALLBACK_FILES = ["data/greenhouse_companies.json", "data/lever_companies.json", "data/ashby_companies.json"];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

async function get(url: string, accept = "*/*"): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: accept };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

async function repoFiles(repo: string, branch = "main"): Promise<string[]> {
  const res = await get(`https://api.github.com/repos/${repo}/git/trees/${branch}?recursive=1`, "application/json");
  const tree = (await res.json()) as { tree?: { path: string; type: string }[] };
  return (tree.tree ?? []).filter((t) => t.type === "blob").map((t) => t.path);
}

/** Feashliaa/job-board-aggregator: one token list per board type (layout discovered via the API). */
async function loadAggregator(): Promise<ExpandCandidate[][]> {
  let files: string[];
  try {
    files = (await repoFiles(AGG_REPO)).filter((p) => p.startsWith("data/") && !p.slice(5).includes("/") && atsFromListPath(p));
    console.log(`${AGG_REPO}: list files ${files.join(", ") || "(none)"}`);
    if (files.length === 0) files = AGG_FALLBACK_FILES;
  } catch (err) {
    console.warn(`${AGG_REPO}: tree listing failed (${errorMessage(err)}); trying known file names`);
    files = AGG_FALLBACK_FILES;
  }
  const lists: ExpandCandidate[][] = [];
  for (const file of files) {
    const ats = atsFromListPath(file)!;
    try {
      const data: unknown = await (await get(`https://raw.githubusercontent.com/${AGG_REPO}/main/${file}`, "application/json")).json();
      const list = parseTokenList(data).map((e) => ({ ats, token: e.token, name: e.name, source: `aggregator:${ats}` }));
      console.log(`${AGG_REPO}/${file}: ${list.length} tokens`);
      lists.push(list);
    } catch (err) {
      console.warn(`${AGG_REPO}/${file} unavailable: ${errorMessage(err)}`);
    }
  }
  return lists;
}

/**
 * remoteintech/remote-jobs: remote-friendly companies with names. Uses boards named directly by the
 * careers URL, or a known aggregator token equal to the company's slug/name (no careers-page scraping).
 */
async function loadRemoteInTech(tokenIndex: Map<AtsKind, Set<string>>): Promise<ExpandCandidate[]> {
  const files = (await repoFiles(RIJ_REPO)).filter((p) => /^src\/companies\/[^/]+\.md$/.test(p));
  const out: ExpandCandidate[] = [];
  const { results } = await mapPoolWithDeadline(files, 16, deadline, Date.now, async (file) => {
    try {
      const fm = parseFrontMatter(await (await get(`https://raw.githubusercontent.com/${RIJ_REPO}/main/${file}`)).text());
      if (!fm.title) return [];
      const slug = fm.slug ?? path.basename(file, ".md");
      const direct = resolveCandidate({ name: fm.title, source: slug, careersUrl: fm.careers_url ?? fm.website });
      if (direct) return [{ ats: direct.ats, token: direct.token, name: fm.title, source: `remoteintech:${slug}` }];
      const keys = new Set([slug.toLowerCase(), nameKey(fm.title)].filter(Boolean));
      const refs: ExpandCandidate[] = [];
      for (const [ats, tokens] of tokenIndex) {
        for (const k of keys) if (tokens.has(k)) refs.push({ ats, token: k, name: fm.title, source: `remoteintech:${slug}` });
      }
      return refs;
    } catch {
      return [];
    }
  });
  for (const r of results) out.push(...r);
  return out;
}

/** The ATS adapters' own 20 s timeout, tightened for probing so dead boards don't hold a slot. */
const probeFetcher: Fetcher = (input, init) => {
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return fetch(input, { ...init, signal });
};

async function main(): Promise<void> {
  const store = new Store(
    httpDriver({
      accountId: requireEnv("CF_ACCOUNT_ID"),
      databaseId: requireEnv("CF_D1_DATABASE_ID"),
      apiToken: requireEnv("CF_D1_API_TOKEN"),
    }),
  );
  const existing = await store.listCompanies({ includeInactive: true });
  const activeBefore = existing.filter((c) => c.state !== "inactive").length;
  const slots = slotsToFill(activeBefore, target);
  console.log(
    `DB: ${existing.length} companies (${activeBefore} active or pending). Target ${target} -> ${slots} to add. ` +
      `Budget ${budgetMin} min.${dryRun ? " DRY RUN." : ""}`,
  );
  if (slots === 0) {
    console.log("Already at or above the target; nothing to do.");
    return;
  }

  const aggLists = await loadAggregator();
  const tokenIndex = new Map<AtsKind, Set<string>>();
  for (const list of aggLists) {
    for (const c of list) {
      const set = tokenIndex.get(c.ats) ?? new Set<string>();
      set.add(c.token.toLowerCase());
      tokenIndex.set(c.ats, set);
    }
  }
  let rij: ExpandCandidate[] = [];
  try {
    rij = await loadRemoteInTech(tokenIndex);
    console.log(`${RIJ_REPO}: ${rij.length} boards`);
  } catch (err) {
    console.warn(`${RIJ_REPO} unavailable: ${errorMessage(err)}`);
  }

  // Remote-friendly (named) companies first, then the big token lists interleaved across board types.
  const candidates = buildCandidates([rij, interleave(aggLists)], existing);
  const rawCount = rij.length + aggLists.reduce((n, l) => n + l.length, 0);
  console.log(`Candidates: ${rawCount} listed, ${candidates.length} new boards to probe (${JSON.stringify(countByAts(candidates))})`);

  let probed = 0;
  const { results: probes, stoppedEarly } = await mapPoolWithDeadline(
    candidates,
    PROBE_CONCURRENCY,
    deadline,
    Date.now,
    async (candidate): Promise<ExpandProbe> => {
      const result = await adapterFor(candidate.ats)
        .listJobs(candidate.token, probeFetcher)
        .catch((err: unknown) => ({ ok: false as const, kind: "parse_error" as const, message: errorMessage(err) }));
      if (++probed % 500 === 0) console.log(`  probed ${probed}/${candidates.length} (${Math.round((Date.now() - startedAt) / 60_000)} min)`);
      return { candidate, result };
    },
  );
  if (stoppedEarly) console.log(`Time budget reached after ${probes.length}/${candidates.length} probes; using what was found.`);

  const failures: Record<string, number> = {};
  for (const p of probes) if (!p.result.ok) failures[p.result.kind] = (failures[p.result.kind] ?? 0) + 1;
  const qualifying = rankQualified(qualify(probes));
  const chosen = selectToInsert(qualifying, activeBefore, target);

  if (!dryRun && chosen.length > 0) {
    const at = Date.now();
    await store.runBatch(chosen.map((c) => store.stmtInsertActiveCompany({ name: c.name, ats: c.ats, boardToken: c.token }, at)));
  }
  const activeAfter = dryRun
    ? activeBefore
    : (await store.listCompanies({ includeInactive: true })).filter((c) => c.state !== "inactive").length;

  console.log("---- Summary ----");
  console.log(`Candidates listed: ${rawCount}; new boards: ${candidates.length}`);
  console.log(`Probed: ${probes.length}${stoppedEarly ? " (stopped by time budget)" : ""}; failures: ${probes.length - probes.filter((p) => p.result.ok).length} ${JSON.stringify(failures)}`);
  console.log(`Qualifying (>=1 open job passing the rules): ${qualifying.length} ${JSON.stringify(countByAts(qualifying))}`);
  console.log(`${dryRun ? "Would insert" : "Inserted"}: ${chosen.length} ${JSON.stringify(countByAts(chosen))}`);
  console.log(`Active companies: ${activeBefore} -> ${dryRun ? activeBefore + chosen.length + " (projected)" : activeAfter}`);
  for (const c of chosen.slice(0, 25)) console.log(`  ${c.passing} passing / ${c.jobs} open  ${c.name} (${c.ats}:${c.token})`);
  if (chosen.length > 25) console.log(`  … and ${chosen.length - 25} more`);
  console.log(`Elapsed: ${((Date.now() - startedAt) / 60_000).toFixed(1)} min`);
}

main().catch((err: unknown) => {
  console.error(`expand failed: ${errorMessage(err)}`);
  process.exit(1);
});
