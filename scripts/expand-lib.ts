// Pure helpers for scripts/expand-companies.ts (tested in test/expand-lib.test.ts).
import { SLUG_PATTERN } from "../src/core/ats/detect";
import { ATS_KINDS, type AtsKind, type FetchResult, type NormalizedJob } from "../src/core/ats/types";
import { DEMOTE_AFTER_MS } from "../src/core/config";
import { matchesTarget } from "../src/core/match/rules";
import type { CompanyState, CompanyTier } from "../src/core/store/db";
import { nameKey, refKey } from "./seed-lib";

export interface ExpandCandidate {
  ats: AtsKind;
  token: string;
  /** Company name when the source has one; otherwise derived from the token. */
  name?: string;
  source: string;
}

export interface ExistingCompany {
  name: string;
  ats: AtsKind;
  boardToken: string;
}

export interface ExpandProbe {
  candidate: ExpandCandidate;
  result: FetchResult<NormalizedJob[]>;
}

export interface QualifiedCompany {
  name: string;
  ats: AtsKind;
  token: string;
  source: string;
  /** Open jobs on the board. */
  jobs: number;
  /** Open jobs passing matchesTarget (role, level and US-remote location). */
  passing: number;
}

const RESERVED_TOKENS = new Set([
  "api", "embed", "v0", "v1", "v2", "v3", "jobs", "careers", "static", "assets", "widget", "www", "apply",
  "job_board", "postings", "boards", "js", "css", "test", "example", "demo",
]);

const MAX_TOKEN_LENGTH = 100;

function cleanToken(raw: unknown): string | undefined {
  if (typeof raw !== "string" && typeof raw !== "number") return undefined;
  const token = String(raw).trim();
  if (!token || token.length > MAX_TOKEN_LENGTH || !SLUG_PATTERN.test(token)) return undefined;
  if (RESERVED_TOKENS.has(token.toLowerCase())) return undefined;
  return token;
}

function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const name = raw.replace(/\s+/g, " ").trim();
  return name && name.length <= 120 ? name : undefined;
}

const TOKEN_FIELDS = ["token", "board_token", "boardToken", "slug", "board", "id", "company_slug"];
const NAME_FIELDS = ["name", "company", "company_name", "companyName", "title", "display_name"];

function pick(obj: Record<string, unknown>, fields: string[]): unknown {
  for (const f of fields) if (obj[f] !== undefined && obj[f] !== null) return obj[f];
  return undefined;
}

/**
 * Parses a board-token list in any of the shapes public lists use: an array of tokens, an array of
 * objects with a token/slug field (and maybe a name), an object keyed by token (value = name or an
 * object), or an object wrapping one of those under `companies`/`boards`/`data`. Invalid tokens are dropped.
 */
export function parseTokenList(data: unknown): { token: string; name?: string }[] {
  const out: { token: string; name?: string }[] = [];
  const add = (tokenRaw: unknown, nameRaw?: unknown) => {
    const token = cleanToken(tokenRaw);
    if (token) out.push({ token, name: cleanName(nameRaw) });
  };
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const obj = item as Record<string, unknown>;
        add(pick(obj, TOKEN_FIELDS), pick(obj, NAME_FIELDS));
      } else {
        add(item);
      }
    }
    return out;
  }
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const key of ["companies", "boards", "data", "tokens"]) {
      if (Array.isArray(obj[key])) return parseTokenList(obj[key]);
    }
    for (const [key, value] of Object.entries(obj)) {
      const name = value && typeof value === "object" ? pick(value as Record<string, unknown>, NAME_FIELDS) : value;
      add(key, name);
    }
  }
  return out;
}

/** Maps a list file path like "data/greenhouse_companies.json" to its board type, if supported. */
export function atsFromListPath(path: string): AtsKind | undefined {
  const base = path.split("/").pop()?.toLowerCase() ?? "";
  if (!base.endsWith(".json")) return undefined;
  return ATS_KINDS.find((k) => base.startsWith(`${k}_`) || base.startsWith(`${k}-`) || base === `${k}.json`);
}

/** Company identity for de-duplicating across boards: the name's alphanumerics. */
export function companyKey(name: string): string {
  return nameKey(name);
}

/** Takes one item from each list in turn, so a time-budget cut doesn't starve any list. */
export function interleave<T>(lists: readonly (readonly T[])[]): T[] {
  const out: T[] = [];
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest; i++) {
    for (const list of lists) if (i < list.length) out.push(list[i]!);
  }
  return out;
}

/**
 * Merges candidate lists (earlier lists first, in order) into one probe list: drops duplicate
 * boards (case-insensitive), boards already in the DB in any state, and boards whose company
 * (by name or token) is already watched on another board type. A later duplicate's name fills in
 * a missing one.
 */
export function buildCandidates(lists: readonly (readonly ExpandCandidate[])[], existing: readonly ExistingCompany[]): ExpandCandidate[] {
  const existingBoards = new Set(existing.map((c) => refKey({ ats: c.ats, token: c.boardToken })));
  const existingCompanies = new Set(existing.flatMap((c) => [companyKey(c.name), companyKey(c.boardToken)]).filter(Boolean));
  const byBoard = new Map<string, ExpandCandidate>();
  for (const list of lists) {
    for (const c of list) {
      const key = refKey(c);
      if (existingBoards.has(key)) continue;
      if (existingCompanies.has(companyKey(c.token)) || (c.name && existingCompanies.has(companyKey(c.name)))) continue;
      const prev = byBoard.get(key);
      if (prev) {
        if (!prev.name && c.name) prev.name = c.name;
        continue;
      }
      byBoard.set(key, { ...c });
    }
  }
  return [...byBoard.values()];
}

const SUFFIX_WORDS = new Set(["inc", "llc", "ltd", "hq", "jobs", "careers", "corp"]);
const ACRONYMS = new Set(["ai", "ml", "io", "hr", "it", "us", "usa", "vr", "ar", "xr", "3d", "api"]);

/**
 * Display name for a board: the source's name when it has one, else the token title-cased with
 * separators as spaces and noise suffixes dropped ("a-place-for-mom" -> "A Place For Mom",
 * "acme-inc" -> "Acme", "10up-2" -> "10up"). Hash-like tokens are returned unchanged.
 */
export function displayName(token: string, name?: string): string {
  const given = name?.replace(/\s+/g, " ").trim();
  if (given) return given;
  if (/^[0-9a-f]{16,}$/i.test(token) || /^\d+$/.test(token)) return token;
  let parts = token.split(/[-_]+/).filter(Boolean);
  while (parts.length > 1 && (/^\d+$/.test(parts[parts.length - 1]!) || SUFFIX_WORDS.has(parts[parts.length - 1]!.toLowerCase()))) {
    parts = parts.slice(0, -1);
  }
  if (parts.length === 0) return token;
  return parts
    .map((p) => (ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join(" ");
}

/** Boards that answered and have at least one open job passing matchesTarget. */
export function qualify(probes: readonly ExpandProbe[]): QualifiedCompany[] {
  const out: QualifiedCompany[] = [];
  for (const { candidate, result } of probes) {
    if (!result.ok) continue;
    const passing = result.value.filter((j) => matchesTarget(j).pass).length;
    if (passing === 0) continue;
    out.push({
      name: displayName(candidate.token, candidate.name),
      ats: candidate.ats,
      token: candidate.token,
      source: candidate.source,
      jobs: result.value.length,
      passing,
    });
  }
  return out;
}

/** A live board found by probing, with the tier it should start in. */
export interface ClassifiedBoard extends QualifiedCompany {
  tier: CompanyTier;
}

export interface ProbeClassification {
  /** Live boards to insert, ranked (fast first), one board per company. */
  boards: ClassifiedBoard[];
  /** Boards that do not exist (404 / unknown site): never inserted. */
  dead: number;
  /** Boards that failed for another reason (timeout, HTTP error, unreadable): skipped this time. */
  failed: number;
}

/**
 * Sorts probes into tiers: a board that answered with at least one open job passing
 * matchesTarget starts 'fast'; any other board that answered OK (even with no open jobs) starts
 * 'wide'. not_found boards are dead and other failures are skipped (re-probed next run).
 */
export function classifyProbes(probes: readonly ExpandProbe[]): ProbeClassification {
  let dead = 0;
  let failed = 0;
  const live: QualifiedCompany[] = [];
  for (const { candidate, result } of probes) {
    if (!result.ok) {
      if (result.kind === "not_found") dead++;
      else failed++;
      continue;
    }
    live.push({
      name: displayName(candidate.token, candidate.name),
      ats: candidate.ats,
      token: candidate.token,
      source: candidate.source,
      jobs: result.value.length,
      passing: result.value.filter((j) => matchesTarget(j).pass).length,
    });
  }
  const boards = rankQualified(live).map((c): ClassifiedBoard => ({ ...c, tier: c.passing > 0 ? "fast" : "wide" }));
  return { boards, dead, failed };
}

export interface DemotionCandidate {
  id: number;
  state: CompanyState;
  tier: CompanyTier;
  lastMatchAt: number | null;
  createdAt: number;
}

/**
 * Weekly demotion rule: an active fast-tier company moves to wide when it has had no new matching
 * job within DEMOTE_AFTER_MS (30 days; never matched counts as no match) and was added more than
 * DEMOTE_AFTER_MS ago (so a newly added board gets a month to show a match).
 */
export function shouldDemote(c: DemotionCandidate, now: number, after: number = DEMOTE_AFTER_MS): boolean {
  if (c.state !== "active" || c.tier !== "fast") return false;
  if (now - c.createdAt <= after) return false;
  return c.lastMatchAt === null || now - c.lastMatchAt > after;
}

/** Ids of the companies to demote from fast to wide. */
export function selectDemotions(companies: readonly DemotionCandidate[], now: number, after: number = DEMOTE_AFTER_MS): number[] {
  return companies.filter((c) => shouldDemote(c, now, after)).map((c) => c.id);
}

/** Ranks by passing jobs (then open jobs, then name) and keeps one board per company. */
export function rankQualified<T extends QualifiedCompany>(list: readonly T[]): T[] {
  const ranked = [...list].sort(
    (a, b) => b.passing - a.passing || b.jobs - a.jobs || a.name.localeCompare(b.name) || refKey(a).localeCompare(refKey(b)),
  );
  const seen = new Set<string>();
  return ranked.filter((c) => {
    const key = companyKey(c.name) || refKey(c);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** How many companies to add so the active total reaches `target` (never negative; Infinity = no cap). */
export function slotsToFill(activeCount: number, target: number): number {
  return Math.max(0, Math.trunc(target) - activeCount);
}

/** The top-ranked companies that fit in the open slots (all of them when `target` is Infinity). */
export function selectToInsert<T extends QualifiedCompany>(list: readonly T[], activeCount: number, target: number): T[] {
  return rankQualified(list).slice(0, slotsToFill(activeCount, target));
}

export function countByAts<T extends { ats: AtsKind }>(list: readonly T[]): Partial<Record<AtsKind, number>> {
  const out: Partial<Record<AtsKind, number>> = {};
  for (const c of list) out[c.ats] = (out[c.ats] ?? 0) + 1;
  return out;
}

/**
 * Runs `fn` over `items` with at most `limit` in flight, starting no new item once `now()` passes
 * `deadline`. Returns the finished results (input order) and whether the budget cut the run short.
 */
export async function mapPoolWithDeadline<T, R>(
  items: readonly T[],
  limit: number,
  deadline: number,
  now: () => number,
  fn: (item: T) => Promise<R>,
): Promise<{ results: R[]; stoppedEarly: boolean }> {
  const results: (R | undefined)[] = new Array(items.length);
  const done: boolean[] = new Array(items.length).fill(false);
  let next = 0;
  let stoppedEarly = false;
  const worker = async () => {
    while (next < items.length) {
      if (now() >= deadline) {
        stoppedEarly = true;
        return;
      }
      const i = next++;
      results[i] = await fn(items[i] as T);
      done[i] = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results: results.filter((_, i) => done[i]) as R[], stoppedEarly };
}

/** Reads a positive number from an env value, else the default. */
export function envNumber(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(n) && n > 0 ? n : fallback;
}
