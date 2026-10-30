import { POSTED_AGO_MAX_MS } from "../config";
import { COUNTRIES, type Country, type LocationClass } from "../match/rules";

/** The location classes that can reach an alert (the others fail matching). */
export type AlertLocationClass = Extract<LocationClass, "us" | "us_restricted" | "intl" | "ambiguous">;
export type JobAction = "applied" | "skipped";

export interface JobAlert {
  title: string;
  companyName: string;
  locationText: string;
  locationClass: AlertLocationClass;
  locationReason?: string;
  /** Countries the posting is remote in (see LocationResult.countries). */
  countries?: readonly Country[];
  /** A remote location is LATAM-wide (names no country). */
  latam?: boolean;
  /** A remote location is Europe/EMEA-wide (and the posting doesn't name the UK). */
  emea?: boolean;
  salaryText?: string;
  postedAt?: number;
  applyUrl: string;
}

export type InlineKeyboardButton =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  /** Telegram copies `copy_text.text` (≤256 chars) to the clipboard when tapped. */
  | { text: string; copy_text: { text: string } };

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

const MAX_TITLE = 200;
const MAX_FIELD = 150;
const MAX_REASON = 200;
const MAX_VISIBLE_URL = 500;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Trims and cuts to at most `max` characters (code points), ending with "…" when cut. */
export function truncate(s: string, max: number): string {
  const chars = Array.from(s.trim());
  return chars.length > max ? chars.slice(0, max - 1).join("") + "…" : chars.join("");
}

function field(s: string, max: number): string {
  return escapeHtml(truncate(s, max));
}

export function formatPostedAgo(postedAt: number | undefined, now: number): string | null {
  if (postedAt === undefined || !Number.isFinite(postedAt)) return null;
  const age = now - postedAt;
  if (age < 0 || age >= POSTED_AGO_MAX_MS) return null;
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** `name` in lists and buttons; `banner` (upper case) in the first line of a non-US alert. */
export const COUNTRY_INFO: Record<Country, { flag: string; name: string; banner: string }> = {
  US: { flag: "🇺🇸", name: "United States", banner: "UNITED STATES" },
  MX: { flag: "🇲🇽", name: "Mexico", banner: "MEXICO" },
  CO: { flag: "🇨🇴", name: "Colombia", banner: "COLOMBIA" },
  AR: { flag: "🇦🇷", name: "Argentina", banner: "ARGENTINA" },
  UK: { flag: "🇬🇧", name: "United Kingdom", banner: "UK" },
};

const LATAM_WARNING = "LATAM — check your country is eligible";
const EMEA_WARNING = "Europe/EMEA — check UK is eligible";
const LATAM_REGION = { flag: "🌎", banner: "LATAM", label: "🌎 LATAM" };
const EMEA_REGION = { flag: "🇪🇺", banner: "EUROPE/EMEA", label: "🇪🇺 Europe/EMEA" };

/** "🇲🇽 Mexico" */
export function countryLabel(c: Country): string {
  return `${COUNTRY_INFO[c].flag} ${COUNTRY_INFO[c].name}`;
}

/**
 * The first line of a non-US alert: "🇲🇽 <b>MEXICO REMOTE</b>", "🇲🇽🇬🇧 <b>MEXICO · UK
 * REMOTE</b>", or, when no country is named, the regions: "🌎 <b>LATAM REMOTE</b>", "🇪🇺
 * <b>EUROPE/EMEA REMOTE</b>" or both.
 */
function intlBanner(abroad: readonly Country[], latam: boolean, emea: boolean): string {
  const parts =
    abroad.length > 0
      ? abroad.map((c) => COUNTRY_INFO[c])
      : [...(latam || !emea ? [LATAM_REGION] : []), ...(emea ? [EMEA_REGION] : [])];
  return `${parts.map((p) => p.flag).join("")} <b>${parts.map((p) => p.banner).join(" · ")} REMOTE</b>`;
}

export function formatJobAlert(job: JobAlert, now: number): string {
  const intl = job.locationClass === "intl";
  const latam = job.latam ?? false;
  const emea = job.emea ?? false;
  const abroad = COUNTRIES.filter((c) => c !== "US" && job.countries?.includes(c));
  const lines = intl ? [intlBanner(abroad, latam, emea)] : [];
  lines.push(`<b>${field(job.title, MAX_TITLE)}</b>`, `🏢 ${field(job.companyName, MAX_FIELD)}`);

  lines.push(`📍 ${field(job.locationText, MAX_FIELD)}`);
  const reason = job.locationReason?.trim();
  if (intl) {
    if (reason) lines.push(`⚠️ ${field(reason, MAX_REASON)}`);
    else if (abroad.length === 0) {
      if (latam || !emea) lines.push(`⚠️ ${LATAM_WARNING}`);
      if (emea) lines.push(`⚠️ ${EMEA_WARNING}`);
    }
  } else if (job.locationClass !== "us") {
    lines.push(`⚠️ ${field(reason || "Check location eligibility", MAX_REASON)}`);
  }
  // Other places the posting is open to: named countries on a US alert, regions next to a country.
  const also = intl ? [] : abroad.map(countryLabel);
  if (!intl || abroad.length > 0) {
    if (latam) also.push(LATAM_REGION.label);
    if (emea) also.push(EMEA_REGION.label);
  }
  if (also.length > 0) lines.push(`Also open to: ${also.join(", ")}`);

  if (job.salaryText?.trim()) lines.push(`💰 ${field(job.salaryText, MAX_FIELD)}`);

  const ago = formatPostedAgo(job.postedAt, now);
  if (ago) lines.push(`🕒 posted ${ago} ago`);

  lines.push("", `<a href="${escapeHtml(job.applyUrl)}">Apply</a>`, `🔗 ${field(job.applyUrl, MAX_VISIBLE_URL)}`);
  return lines.join("\n");
}

/** A button's callback_data, or undefined for url/copy buttons. */
export function callbackDataOf(b: InlineKeyboardButton): string | undefined {
  return "callback_data" in b ? b.callback_data : undefined;
}

/** Telegram's limit for a copy_text button's text. */
export const MAX_COPY_TEXT = 256;

/** "📋 Copy link" (when the URL fits Telegram's copy limit) and "🌐 Open" for an https apply URL. */
export function linkRow(applyUrl: string | undefined): InlineKeyboardButton[] {
  if (!applyUrl || !applyUrl.startsWith("https://")) return [];
  const row: InlineKeyboardButton[] = [];
  if (applyUrl.length <= MAX_COPY_TEXT) row.push({ text: "📋 Copy link", copy_text: { text: applyUrl } });
  row.push({ text: "🌐 Open", url: applyUrl });
  return row;
}

/**
 * Applied/Skip row for a job, plus extra rows (the link row) appended unchanged. Without
 * `extraRows`, the link row is built from `applyUrl`.
 */
export function jobKeyboard(
  jobId: number,
  action?: JobAction,
  links: { applyUrl?: string; extraRows?: InlineKeyboardButton[][] } = {},
): InlineKeyboardMarkup {
  const actionRow = actionKeyboard(jobId, action).inline_keyboard[0]!;
  const extra = links.extraRows ?? (linkRow(links.applyUrl).length ? [linkRow(links.applyUrl)] : []);
  return { inline_keyboard: [actionRow, ...extra] };
}

function actionKeyboard(jobId: number, action?: JobAction): InlineKeyboardMarkup {
  const applied = `a:${jobId}`;
  const skipped = `s:${jobId}`;
  if (action === "applied") {
    return {
      inline_keyboard: [[
        { text: "✅ Applied ✓", callback_data: applied },
        { text: "↩️ Mark skipped", callback_data: skipped },
      ]],
    };
  }
  if (action === "skipped") {
    return {
      inline_keyboard: [[
        { text: "❌ Skipped ✓", callback_data: skipped },
        { text: "↩️ Mark applied", callback_data: applied },
      ]],
    };
  }
  return {
    inline_keyboard: [[
      { text: "✅ Applied", callback_data: applied },
      { text: "❌ Skip", callback_data: skipped },
    ]],
  };
}

const CALLBACK_RE = /^([as]):([1-9]\d{0,15})$/;

export function parseCallbackData(data: string): { action: JobAction; jobId: number } | null {
  const m = CALLBACK_RE.exec(data);
  if (!m) return null;
  const jobId = Number(m[2]);
  if (!Number.isSafeInteger(jobId)) return null;
  return { action: m[1] === "a" ? "applied" : "skipped", jobId };
}

/** /countries keyboard: one toggle per country, ✅ when selected, two per row in COUNTRIES order. */
export function countriesKeyboard(selected: readonly Country[]): InlineKeyboardMarkup {
  const buttons = COUNTRIES.map((c) => ({
    text: `${selected.includes(c) ? "✅" : "⬜"} ${countryLabel(c)}`,
    callback_data: `c:${c}`,
  }));
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2));
  return { inline_keyboard: rows };
}

const COUNTRY_CALLBACK_RE = /^c:([A-Z]{2})$/;

/** The country of a /countries button ("c:CO"), or null. */
export function parseCountryCallback(data: string): Country | null {
  const code = COUNTRY_CALLBACK_RE.exec(data)?.[1];
  return code !== undefined && (COUNTRIES as readonly string[]).includes(code) ? (code as Country) : null;
}
