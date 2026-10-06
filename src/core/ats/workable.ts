import { failure, fetchJson } from "./http";
import { countryCode, htmlToText, isRecord, str, toEpochMs, unique } from "./text";
import type { AtsAdapter, NormalizedJob, RemoteSignal } from "./types";

const API = "https://apply.workable.com/api";
/** Guards against a nextPage token that never ends. */
const MAX_PAGES = 50;

function workableRemote(workplace: unknown, remote: unknown): RemoteSignal {
  if (workplace === "remote") return "yes";
  if (workplace === "hybrid" || workplace === "on_site") return "no";
  if (remote === true) return "yes";
  if (remote === false) return "no";
  return "unknown";
}

function normalize(account: string, raw: unknown): NormalizedJob | undefined {
  if (!isRecord(raw)) return undefined;
  const shortcode = str(raw.shortcode);
  const title = str(raw.title)?.trim();
  // The shortcode becomes part of the apply URL, so only plain alphanumerics are accepted.
  if (!shortcode || !/^[A-Za-z0-9]+$/.test(shortcode) || !title) return undefined;

  const loc = isRecord(raw.location) ? raw.location : {};
  const locationText = [str(loc.city), str(loc.region), str(loc.country)]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join(", ");
  const others = Array.isArray(raw.locations) ? raw.locations.filter(isRecord) : [];
  const countries = [loc, ...others]
    .map((l) => countryCode(l.countryCode) ?? countryCode(l.country))
    .filter((c): c is string => !!c);

  return {
    id: shortcode,
    title,
    locationText,
    remote: workableRemote(raw.workplace, raw.remote),
    countryCodes: unique(countries),
    applyUrl: `https://apply.workable.com/${encodeURIComponent(account)}/j/${shortcode}/`,
    postedAt: toEpochMs(raw.published),
  };
}

export const workable: AtsAdapter = {
  kind: "workable",

  async listJobs(token, fetcher) {
    const url = `${API}/v3/accounts/${encodeURIComponent(token)}/jobs`;
    const jobs: NormalizedJob[] = [];
    const seenPages = new Set<string>();
    let body: Record<string, string> = {};

    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await fetchJson(fetcher, url, { method: "POST", body });
      if (!res.ok) return res;
      if (!isRecord(res.value) || !Array.isArray(res.value.results)) {
        return failure("parse_error", "Workable response has no results array");
      }
      for (const raw of res.value.results) {
        const job = normalize(token, raw);
        if (job) jobs.push(job);
      }
      const next = str(res.value.nextPage);
      if (!next || seenPages.has(next)) break;
      seenPages.add(next);
      body = { token: next };
    }
    return { ok: true, value: jobs };
  },

  async fetchDetail(token, jobId, fetcher) {
    const url = `${API}/v2/accounts/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}`;
    const res = await fetchJson(fetcher, url);
    if (!res.ok) return res;
    if (!isRecord(res.value)) return failure("parse_error", "Workable job detail is not an object");
    const detail = res.value;
    const description = [detail.description, detail.requirements, detail.benefits]
      .map((h) => htmlToText(str(h) ?? ""))
      .filter(Boolean)
      .join("\n\n");
    return { ok: true, value: { description } };
  },
};
