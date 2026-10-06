import { failure, fetchJson } from "./http";
import { countriesInText, decodeEntities, formatMoneyRange, htmlToText, isHttpsUrl, isRecord, str, toEpochMs } from "./text";
import type { AtsAdapter, JobDetail, NormalizedJob, RemoteSignal } from "./types";

const API = "https://boards-api.greenhouse.io/v1/boards";

/** Greenhouse has no remote field, so the signal comes from location and office text. */
export function greenhouseRemote(text: string): RemoteSignal {
  const t = text.toLowerCase();
  if (/\bhybrid\b|\bon-?site\b|\bin[- ]office\b/.test(t)) return "no";
  if (/\bremote\b/.test(t)) return "yes";
  return "unknown";
}

function normalize(raw: unknown): NormalizedJob | undefined {
  if (!isRecord(raw)) return undefined;
  const id = raw.id;
  const title = str(raw.title)?.trim();
  if ((typeof id !== "number" && typeof id !== "string") || !title) return undefined;
  if (!isHttpsUrl(raw.absolute_url)) return undefined;

  const locationText = (isRecord(raw.location) ? str(raw.location.name) : undefined)?.trim() ?? "";
  const offices = Array.isArray(raw.offices)
    ? raw.offices.map((o) => (isRecord(o) ? str(o.name) : undefined)).filter((n): n is string => !!n)
    : [];
  const signalText = [locationText, ...offices].join(" ; ");

  return {
    id: String(id),
    title,
    locationText,
    remote: greenhouseRemote(signalText),
    countryCodes: countriesInText(signalText),
    applyUrl: raw.absolute_url,
    postedAt: toEpochMs(raw.first_published) ?? toEpochMs(raw.updated_at),
  };
}

function salaryFromRanges(ranges: unknown): string | undefined {
  if (!Array.isArray(ranges)) return undefined;
  const parts = ranges
    .filter(isRecord)
    .map((r) =>
      formatMoneyRange(
        typeof r.min_cents === "number" ? r.min_cents / 100 : undefined,
        typeof r.max_cents === "number" ? r.max_cents / 100 : undefined,
        str(r.currency_type),
      ),
    )
    .filter((s): s is string => !!s);
  return parts.length ? [...new Set(parts)].join("; ") : undefined;
}

export const greenhouse: AtsAdapter = {
  kind: "greenhouse",

  async listJobs(token, fetcher) {
    const res = await fetchJson(fetcher, `${API}/${encodeURIComponent(token)}/jobs`);
    if (!res.ok) return res;
    if (!isRecord(res.value) || !Array.isArray(res.value.jobs)) {
      return failure("parse_error", "Greenhouse response has no jobs array");
    }
    const jobs = res.value.jobs.map(normalize).filter((j): j is NormalizedJob => !!j);
    return { ok: true, value: jobs };
  },

  async fetchDetail(token, jobId, fetcher) {
    const url = `${API}/${encodeURIComponent(token)}/jobs/${encodeURIComponent(jobId)}?pay_transparency=true`;
    const res = await fetchJson(fetcher, url);
    if (!res.ok) return res;
    if (!isRecord(res.value)) return failure("parse_error", "Greenhouse job detail is not an object");
    // `content` is HTML whose markup is itself entity-escaped, so decode once before converting.
    const content = str(res.value.content) ?? "";
    const detail: JobDetail = { description: htmlToText(decodeEntities(content)) };
    const salaryText = salaryFromRanges(res.value.pay_input_ranges);
    if (salaryText) detail.salaryText = salaryText;
    return { ok: true, value: detail };
  },
};
