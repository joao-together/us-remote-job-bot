import { ashby } from "./ashby";
import { greenhouse } from "./greenhouse";
import { failure } from "./http";
import { lever } from "./lever";
import { ATS_KINDS, ATS_NAMES, atsNameList, type AtsAdapter, type AtsKind, type BoardRef, type FetchFailure, type FetchResult, type Fetcher, type NormalizedJob } from "./types";
import { workable } from "./workable";

export const SLUG_PATTERN = /^[A-Za-z0-9_-]+$/;

const ADAPTERS: Record<AtsKind, AtsAdapter> = { greenhouse, lever, ashby, workable };

export function adapterFor(kind: AtsKind): AtsAdapter {
  return ADAPTERS[kind];
}

export type ParsedBoardInput = BoardRef | { slug: string } | { error: string };

function firstSegment(url: URL): string {
  return url.pathname.split("/").filter(Boolean)[0] ?? "";
}

/** Maps a known board URL to (board type, raw token); undefined when the host is not a known board. */
function matchBoardUrl(url: URL): { ats: AtsKind; token: string } | undefined {
  const host = url.hostname.toLowerCase();
  if (host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io") {
    const first = firstSegment(url);
    const token = first === "embed" ? (url.searchParams.get("for") ?? "") : first;
    return { ats: "greenhouse", token };
  }
  if (host === "jobs.lever.co") return { ats: "lever", token: firstSegment(url) };
  if (host === "jobs.ashbyhq.com") return { ats: "ashby", token: firstSegment(url) };
  if (host === "apply.workable.com") return { ats: "workable", token: firstSegment(url) };
  const sub = /^([^.]+)\.workable\.com$/.exec(host)?.[1];
  if (sub && sub !== "www" && sub !== "apply") return { ats: "workable", token: sub };
  return undefined;
}

/**
 * Parses a careers URL or a bare board slug. Known board URLs give a BoardRef;
 * a safe bare slug gives { slug } to be resolved later by probing.
 */
export function parseBoardInput(input: string): ParsedBoardInput {
  const text = input.trim();
  if (!text) return { error: "Send a careers page URL or a board slug." };
  if (SLUG_PATTERN.test(text)) return { slug: text };

  const looksLikeUrl = /^https?:\/\//i.test(text) || /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(text);
  if (!looksLikeUrl) {
    return { error: "A board slug may only contain letters, digits, '-' and '_'." };
  }

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { error: "That doesn't look like a valid URL." };
  }

  const match = matchBoardUrl(url);
  if (!match) {
    if (url.searchParams.has("gh_jid")) {
      return { error: "That page embeds a Greenhouse board; send the boards.greenhouse.io link or the board slug instead." };
    }
    return { error: `Unrecognized careers URL. Supported: ${atsNameList("and")} board links.` };
  }
  if (!SLUG_PATTERN.test(match.token)) {
    return { error: `Couldn't find a valid ${ATS_NAMES[match.ats]} board name in that URL.` };
  }
  return { ats: match.ats, token: match.token };
}

/**
 * Resolves a bare slug by trying each board type in order. A board with jobs wins;
 * otherwise the first valid empty board is used. Runs only in the poller.
 */
export async function probeBoard(
  slug: string,
  fetcher: Fetcher,
): Promise<FetchResult<{ ref: BoardRef; jobs: NormalizedJob[] }>> {
  if (!SLUG_PATTERN.test(slug)) return failure("not_found", "Not a valid board slug");

  let emptyBoard: BoardRef | undefined;
  let firstError: FetchFailure | undefined;

  for (const kind of ATS_KINDS) {
    const res = await adapterFor(kind).listJobs(slug, fetcher);
    if (res.ok) {
      if (res.value.length > 0) return { ok: true, value: { ref: { ats: kind, token: slug }, jobs: res.value } };
      emptyBoard ??= { ats: kind, token: slug };
    } else if (res.kind !== "not_found") {
      firstError ??= res;
    }
  }

  if (emptyBoard) return { ok: true, value: { ref: emptyBoard, jobs: [] } };
  if (firstError) return firstError;
  return failure("not_found", `No ${atsNameList("or")} board named "${slug}"`);
}
