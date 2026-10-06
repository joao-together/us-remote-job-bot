import { REQUEST_TIMEOUT_MS, USER_AGENT } from "../config";
import type { FetchFailure, FetchFailureKind, FetchResult, Fetcher } from "./types";
import { errorMessage } from "../util";

export function failure(kind: FetchFailureKind, message: string): FetchFailure {
  return { ok: false, kind, message };
}

export interface JsonRequest {
  method?: "GET" | "POST";
  /** Sent as a JSON request body. */
  body?: unknown;
}

/**
 * Fetches and parses JSON with a timeout and the bot's User-Agent.
 * Never throws: 404 -> not_found, other non-2xx or network error -> http_error,
 * abort -> timeout, invalid JSON -> parse_error.
 */
export async function fetchJson(fetcher: Fetcher, url: string, req: JsonRequest = {}): Promise<FetchResult<unknown>> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json" };
  const init: RequestInit = { method: req.method ?? "GET", headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) };
  if (req.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(req.body);
  }

  let res: Response;
  try {
    res = await fetcher(url, init);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") return failure("timeout", `Timed out fetching ${url}`);
    return failure("http_error", `Network error fetching ${url}: ${errorMessage(err)}`);
  }

  let text: string;
  try {
    text = await res.text();
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "AbortError" || name === "TimeoutError") return failure("timeout", `Timed out reading ${url}`);
    return failure("http_error", `Failed reading ${url}`);
  }

  if (res.status === 404) return failure("not_found", `Not found: ${url}`);
  if (!res.ok) return failure("http_error", `HTTP ${res.status} from ${url}`);

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return failure("parse_error", `Invalid JSON from ${url}`);
  }
}
