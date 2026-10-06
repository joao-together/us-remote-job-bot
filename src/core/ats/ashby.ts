import { failure, fetchJson } from "./http";
import { isRecord } from "../util";
import { countryCode, htmlToText, isHttpsUrl, str, toEpochMs, unique } from "./text";
import type { AtsAdapter, NormalizedJob, RemoteSignal } from "./types";

const API = "https://api.ashbyhq.com/posting-api/job-board";

function ashbyRemote(workplaceType: unknown, isRemote: unknown): RemoteSignal {
  if (workplaceType === "Remote") return "yes";
  if (workplaceType === "OnSite" || workplaceType === "Hybrid") return "no";
  return isRemote === true ? "yes" : "unknown";
}

function addressCountry(holder: unknown): string | undefined {
  if (!isRecord(holder) || !isRecord(holder.address) || !isRecord(holder.address.postalAddress)) return undefined;
  return countryCode(holder.address.postalAddress.addressCountry);
}

function normalize(raw: unknown): NormalizedJob | undefined {
  if (!isRecord(raw) || raw.isListed === false) return undefined;
  const id = str(raw.id);
  const title = str(raw.title)?.trim();
  if (!id || !title) return undefined;
  const applyUrl = str(raw.jobUrl) ?? str(raw.applyUrl);
  if (!isHttpsUrl(applyUrl)) return undefined;

  const secondary = Array.isArray(raw.secondaryLocations) ? raw.secondaryLocations.filter(isRecord) : [];
  const locations = [str(raw.location), ...secondary.map((s) => str(s.location))]
    .map((l) => l?.trim())
    .filter((l): l is string => !!l);
  const countries = [addressCountry(raw), ...secondary.map(addressCountry)].filter((c): c is string => !!c);

  const html = str(raw.descriptionHtml);
  const description = html ? htmlToText(html) : str(raw.descriptionPlain)?.trim();
  const comp = isRecord(raw.compensation) ? raw.compensation : {};
  const salaryText = (str(comp.compensationTierSummary) ?? str(comp.scrapeableCompensationSalarySummary))?.trim();

  return {
    id,
    title,
    locationText: unique(locations).join(" / "),
    remote: ashbyRemote(raw.workplaceType, raw.isRemote),
    countryCodes: unique(countries),
    applyUrl,
    // Informational only: Ashby's publishedAt can be years old for evergreen postings.
    postedAt: toEpochMs(raw.publishedAt),
    salaryText: salaryText || undefined,
    description: description || undefined,
  };
}

export const ashby: AtsAdapter = {
  kind: "ashby",

  async listJobs(token, fetcher) {
    const res = await fetchJson(fetcher, `${API}/${encodeURIComponent(token)}?includeCompensation=true`);
    if (!res.ok) return res;
    if (!isRecord(res.value) || !Array.isArray(res.value.jobs)) {
      return failure("parse_error", "Ashby response has no jobs array");
    }
    const jobs = res.value.jobs.map(normalize).filter((j): j is NormalizedJob => !!j);
    return { ok: true, value: jobs };
  },
};
