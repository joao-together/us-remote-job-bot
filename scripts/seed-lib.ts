import { parseBoardInput, SLUG_PATTERN } from "../src/core/ats/detect";
import type { AtsKind, BoardRef, FetchResult, NormalizedJob } from "../src/core/ats/types";
import { classifyLocation, isSoftwareEngineeringRole, locationPasses } from "../src/core/match/rules";

export interface Candidate {
  name: string;
  source: string;
  careersUrl?: string;
  ref?: BoardRef;
}

export interface ResolvedCandidate {
  name: string;
  source: string;
  ref: BoardRef;
}

export interface SeedCompany {
  name: string;
  ats: AtsKind;
  token: string;
  jobs: number;
  softwareJobs: number;
  usSoftwareJobs: number;
}

export interface ProbeOutcome {
  candidate: ResolvedCandidate;
  result: FetchResult<NormalizedJob[]>;
}

const RESERVED_TOKENS = new Set([
  "api", "embed", "v0", "v1", "v2", "v3", "jobs", "careers", "static", "assets", "widget", "www", "apply",
  "job_board", "posting-api", "postings", "boards", "js", "css", "favicon.ico",
]);

export function refKey(ref: BoardRef): string {
  return `${ref.ats}:${ref.token.toLowerCase()}`;
}

/** Resolves a candidate from its explicit ref or a known board careers URL. */
export function resolveCandidate(c: Candidate): BoardRef | undefined {
  if (c.ref) return c.ref;
  if (!c.careersUrl) return undefined;
  const parsed = parseBoardInput(c.careersUrl);
  return "ats" in parsed ? parsed : undefined;
}

/** Keeps the first candidate per (ats, token), case-insensitively. */
export function dedupeCandidates(list: ResolvedCandidate[]): ResolvedCandidate[] {
  const seen = new Set<string>();
  const out: ResolvedCandidate[] = [];
  for (const c of list) {
    const key = refKey(c.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

function decodeEntities(s: string): string {
  return s.replace(/&amp;/gi, "&").replace(/&#x2F;/gi, "/").replace(/&#47;/g, "/").replace(/\\\//g, "/");
}

function refFromBoardLink(link: string): BoardRef | undefined {
  const url = `https://${link}`;
  let m = /^https:\/\/boards-api\.greenhouse\.io\/v1\/boards\/([^/?#]+)/i.exec(url);
  if (m) return { ats: "greenhouse", token: m[1]! };
  m = /^https:\/\/api(?:\.eu)?\.lever\.co\/v0\/postings\/([^/?#]+)/i.exec(url);
  if (m) return { ats: "lever", token: m[1]! };
  m = /^https:\/\/api\.ashbyhq\.com\/posting-api\/job-board\/([^/?#]+)/i.exec(url);
  if (m) return { ats: "ashby", token: m[1]! };
  const parsed = parseBoardInput(url);
  return "ats" in parsed ? parsed : undefined;
}

/** Finds Greenhouse/Lever/Ashby/Workable board links in careers HTML, most frequent first. */
export function extractBoardLinks(html: string): BoardRef[] {
  const text = decodeEntities(html);
  const re = /(?:[a-z0-9-]+\.)+(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com)\/[^\s"'<>\\)`]*/gi;
  const counts = new Map<string, { ref: BoardRef; n: number }>();
  for (const match of text.matchAll(re)) {
    const ref = refFromBoardLink(match[0]);
    if (!ref || !SLUG_PATTERN.test(ref.token) || RESERVED_TOKENS.has(ref.token.toLowerCase())) continue;
    const key = refKey(ref);
    const entry = counts.get(key);
    if (entry) entry.n++;
    else counts.set(key, { ref, n: 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n).map((e) => e.ref);
}

/** Turns probe results into seed rows: board responded OK and has at least one software role. */
export function selectValid(outcomes: ProbeOutcome[]): SeedCompany[] {
  const out: SeedCompany[] = [];
  for (const { candidate, result } of outcomes) {
    if (!result.ok) continue;
    const software = result.value.filter((j) => isSoftwareEngineeringRole(j.title));
    if (software.length === 0) continue;
    out.push({
      name: candidate.name,
      ats: candidate.ref.ats,
      token: candidate.ref.token,
      jobs: result.value.length,
      softwareJobs: software.length,
      usSoftwareJobs: software.filter((j) => locationPasses(classifyLocation(j).cls)).length,
    });
  }
  return out;
}

/** One board per company name (a company can show up on an old and a new ATS); keeps the one with more software jobs. */
export function collapseByName(list: SeedCompany[]): SeedCompany[] {
  const best = new Map<string, SeedCompany>();
  for (const c of list) {
    const key = c.name.trim().toLowerCase();
    const prev = best.get(key);
    if (!prev || c.softwareJobs > prev.softwareJobs) best.set(key, c);
  }
  return [...best.values()];
}

/** Lowercase alphanumerics of a company name or slug, for matching against known board tokens. */
export function nameKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Keeps the top `cap` companies by US-eligible then total software jobs, sorted by name. */
export function rankAndCap(list: SeedCompany[], cap: number): SeedCompany[] {
  const ranked = [...list].sort(
    (a, b) => b.usSoftwareJobs - a.usSoftwareJobs || b.softwareJobs - a.softwareJobs || a.name.localeCompare(b.name),
  );
  return ranked.slice(0, cap).sort((a, b) => a.name.localeCompare(b.name) || refKey(a).localeCompare(refKey(b)));
}

export function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Idempotent inserts: seed companies start active and unbaselined so the poller baselines them silently. */
export function buildSeedSql(list: SeedCompany[], createdAt: number): string {
  const lines = list.map(
    (c) =>
      `INSERT INTO companies (name, ats, board_token, state, baselined, consecutive_failures, created_at) VALUES (${sqlString(c.name)}, ${sqlString(c.ats)}, ${sqlString(c.token)}, 'active', 0, 0, ${Math.trunc(createdAt)}) ON CONFLICT(ats, board_token) DO NOTHING;`,
  );
  return `${lines.join("\n")}\n`;
}

/** Reads `key: value` pairs from a Markdown file's YAML front matter (scalars only). */
export function parseFrontMatter(md: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!kv || !kv[2]) continue;
    out[kv[1]!] = kv[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
