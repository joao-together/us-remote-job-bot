import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { adapterFor, parseBoardInput } from "../src/core/ats/detect";
import type { AtsKind, BoardRef, Fetcher } from "../src/core/ats/types";
import { FETCH_CONCURRENCY, USER_AGENT } from "../src/core/config";
import {
  buildSeedSql,
  collapseByName,
  dedupeCandidates,
  extractBoardLinks,
  nameKey,
  parseFrontMatter,
  rankAndCap,
  resolveCandidate,
  selectValid,
  type Candidate,
  type ProbeOutcome,
  type ResolvedCandidate,
} from "./seed-lib";

const ROOT = path.resolve(import.meta.dirname, "..");
const CAP = 350;
const HTML_TIMEOUT_MS = 15_000;
const fetcher: Fetcher = fetch;

interface CandidateSource {
  name: string;
  license: string;
  load(): Promise<Candidate[]>;
}

interface TokenIndexSource {
  name: string;
  license: string;
  urls: Partial<Record<AtsKind, string>>;
}

const RIJ_RAW = "https://raw.githubusercontent.com/remoteintech/remote-jobs/main";
const AGG_RAW = "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data";

const SOURCES: CandidateSource[] = [
  { name: "scripts/seed-extra.json", license: "own", load: loadExtra },
  { name: "remoteintech/remote-jobs", license: "ISC", load: loadRemoteInTech },
];

// Known board tokens used only to resolve candidates whose careers page hides its board.
const TOKEN_INDEXES: TokenIndexSource[] = [
  {
    name: "Feashliaa/job-board-aggregator",
    license: "MIT",
    urls: {
      greenhouse: `${AGG_RAW}/greenhouse_companies.json`,
      lever: `${AGG_RAW}/lever_companies.json`,
      ashby: `${AGG_RAW}/ashby_companies.json`,
    },
  },
];

async function get(url: string, accept = "*/*"): Promise<Response> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: accept };
  if (url.startsWith("https://api.github.com/") && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(HTML_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res;
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

async function loadExtra(): Promise<Candidate[]> {
  const raw = JSON.parse(await readFile(path.join(ROOT, "scripts/seed-extra.json"), "utf8")) as (BoardRef & { name: string })[];
  return raw.map((e) => ({ name: e.name, source: "extra", ref: { ats: e.ats, token: e.token } }));
}

async function loadRemoteInTech(): Promise<Candidate[]> {
  const tree = (await (await get("https://api.github.com/repos/remoteintech/remote-jobs/git/trees/main?recursive=1", "application/json")).json()) as {
    tree: { path: string }[];
  };
  const files = tree.tree.map((t) => t.path).filter((p) => /^src\/companies\/[^/]+\.md$/.test(p));
  const results = await mapPool(files, 16, async (file) => {
    try {
      const fm = parseFrontMatter(await (await get(`${RIJ_RAW}/${file}`)).text());
      if (!fm.title) return undefined;
      const slug = fm.slug ?? path.basename(file, ".md");
      return { name: fm.title, source: `remoteintech:${slug}`, careersUrl: fm.careers_url ?? fm.website } satisfies Candidate;
    } catch {
      return undefined;
    }
  });
  return results.filter((c): c is NonNullable<typeof c> => c !== undefined);
}

async function loadTokenIndex(): Promise<Map<AtsKind, Set<string>>> {
  const index = new Map<AtsKind, Set<string>>();
  for (const src of TOKEN_INDEXES) {
    for (const [ats, url] of Object.entries(src.urls) as [AtsKind, string][]) {
      try {
        const tokens = (await (await get(url, "application/json")).json()) as string[];
        const set = index.get(ats) ?? new Set<string>();
        for (const t of tokens) set.add(t.toLowerCase());
        index.set(ats, set);
      } catch (err) {
        console.warn(`Token index ${src.name}/${ats} unavailable: ${(err as Error).message}`);
      }
    }
  }
  return index;
}

async function resolveFromHtml(url: string): Promise<BoardRef | undefined> {
  try {
    const res = await get(/^https?:\/\//i.test(url) ? url : `https://${url}`, "text/html");
    const final = parseBoardInput(res.url);
    if ("ats" in final) return final;
    return extractBoardLinks(await res.text())[0];
  } catch {
    return undefined;
  }
}

function guessFromIndex(c: Candidate, index: Map<AtsKind, Set<string>>): BoardRef[] {
  const keys = new Set([c.source.split(":")[1] ?? "", nameKey(c.name)].filter(Boolean).map((k) => k.toLowerCase()));
  const refs: BoardRef[] = [];
  for (const [ats, tokens] of index) {
    for (const k of keys) if (tokens.has(k)) refs.push({ ats, token: k });
  }
  return refs;
}

async function main(): Promise<void> {
  const candidates: Candidate[] = [];
  for (const src of SOURCES) {
    try {
      const list = await src.load();
      console.log(`${src.name} (${src.license}): ${list.length} candidates`);
      candidates.push(...list);
    } catch (err) {
      console.warn(`Source ${src.name} unavailable: ${(err as Error).message}`);
    }
  }
  const index = await loadTokenIndex();

  let viaUrl = 0, viaHtml = 0, viaIndex = 0;
  const resolvedLists = await mapPool(candidates, FETCH_CONCURRENCY, async (c): Promise<ResolvedCandidate[]> => {
    const direct = resolveCandidate(c);
    if (direct) {
      viaUrl++;
      return [{ name: c.name, source: c.source, ref: direct }];
    }
    const fromHtml = c.careersUrl ? await resolveFromHtml(c.careersUrl) : undefined;
    if (fromHtml) {
      viaHtml++;
      return [{ name: c.name, source: c.source, ref: fromHtml }];
    }
    const guesses = guessFromIndex(c, index);
    if (guesses.length) viaIndex++;
    return guesses.map((ref) => ({ name: c.name, source: c.source, ref }));
  });
  const resolved = dedupeCandidates(resolvedLists.flat());
  console.log(`Resolved: ${resolved.length} boards (url ${viaUrl}, careers html ${viaHtml}, token index ${viaIndex})`);

  let done = 0;
  const outcomes = await mapPool(resolved, FETCH_CONCURRENCY, async (candidate): Promise<ProbeOutcome> => {
    const result = await adapterFor(candidate.ref.ats).listJobs(candidate.ref.token, fetcher);
    if (++done % 50 === 0) console.log(`  probed ${done}/${resolved.length}`);
    return { candidate, result };
  });
  const failed = outcomes.filter((o) => !o.result.ok).length;
  const valid = collapseByName(selectValid(outcomes));
  const written = rankAndCap(valid, CAP);

  await mkdir(path.join(ROOT, "seed"), { recursive: true });
  const json = written.map(({ name, ats, token, jobs, softwareJobs, usSoftwareJobs }) => ({ name, ats, token, jobs, softwareJobs, usSoftwareJobs }));
  await writeFile(path.join(ROOT, "seed/companies.json"), `${JSON.stringify(json, null, 2)}\n`);
  await writeFile(path.join(ROOT, "seed/companies.sql"), buildSeedSql(written, Date.now()));

  const perAts: Record<string, number> = {};
  for (const c of written) perAts[c.ats] = (perAts[c.ats] ?? 0) + 1;
  console.log(
    `Candidates ${candidates.length}, resolved ${resolved.length}, probe failures ${failed}, valid ${valid.length}, written ${written.length}`,
  );
  console.log(`Per ATS: ${JSON.stringify(perAts)}`);
}

await main();
