import { failure, fetchJson } from "./http";
import { countryCode, formatMoneyRange, htmlToText, isHttpsUrl, isRecord, str, toEpochMs, unique } from "./text";
import type { AtsAdapter, NormalizedJob, RemoteSignal } from "./types";

const API = "https://api.lever.co/v0/postings";

const INTERVALS: Record<string, string> = {
  "per-year-salary": "/yr",
  "per-month-salary": "/mo",
  "per-week-salary": "/wk",
  "per-day-wage": "/day",
  "per-hour-wage": "/hr",
};

function leverRemote(workplaceType: unknown): RemoteSignal {
  switch (workplaceType) {
    case "remote":
      return "yes";
    case "on-site":
    case "onsite":
    case "hybrid":
      return "no";
    default:
      return "unknown";
  }
}

function salaryText(range: unknown): string | undefined {
  if (!isRecord(range)) return undefined;
  const min = typeof range.min === "number" ? range.min : undefined;
  const max = typeof range.max === "number" ? range.max : undefined;
  const text = formatMoneyRange(min, max, str(range.currency));
  if (!text) return undefined;
  const interval = INTERVALS[str(range.interval) ?? ""];
  return interval ? `${text}${interval}` : text;
}

function description(raw: Record<string, unknown>): string | undefined {
  const lists = Array.isArray(raw.lists)
    ? raw.lists
        .filter(isRecord)
        .map((l) => [str(l.text), htmlToText(str(l.content) ?? "")].filter(Boolean).join("\n"))
    : [];
  const parts = [str(raw.descriptionPlain), ...lists, str(raw.additionalPlain)]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p);
  return parts.length ? parts.join("\n\n") : undefined;
}

function normalize(raw: unknown): NormalizedJob | undefined {
  if (!isRecord(raw)) return undefined;
  const id = str(raw.id);
  const title = str(raw.text)?.trim();
  if (!id || !title) return undefined;
  const applyUrl = str(raw.hostedUrl) ?? str(raw.applyUrl);
  if (!isHttpsUrl(applyUrl)) return undefined;

  const categories = isRecord(raw.categories) ? raw.categories : {};
  const all = Array.isArray(categories.allLocations)
    ? categories.allLocations.filter((l): l is string => typeof l === "string" && l.trim() !== "")
    : [];
  const locations = all.length ? all : [str(categories.location) ?? ""];
  const country = countryCode(raw.country);

  return {
    id,
    title,
    locationText: unique(locations.map((l) => l.trim()).filter(Boolean)).join(" / "),
    remote: leverRemote(raw.workplaceType),
    countryCodes: country ? [country] : [],
    applyUrl,
    postedAt: toEpochMs(raw.createdAt),
    salaryText: salaryText(raw.salaryRange),
    description: description(raw),
  };
}

export const lever: AtsAdapter = {
  kind: "lever",

  async listJobs(token, fetcher) {
    const res = await fetchJson(fetcher, `${API}/${encodeURIComponent(token)}?mode=json`);
    if (!res.ok) return res;
    // Unknown sites answer {"ok":false,"error":"Document not found"}.
    if (isRecord(res.value) && res.value.ok === false) {
      return failure("not_found", `Lever site not found: ${str(res.value.error) ?? "unknown error"}`);
    }
    if (!Array.isArray(res.value)) return failure("parse_error", "Lever response is not an array");
    const jobs = res.value.map(normalize).filter((j): j is NormalizedJob => !!j);
    return { ok: true, value: jobs };
  },
};
