import { POSTED_AGO_MAX_MS } from "../config";
import type { LocationClass } from "../match/rules";

/** The location classes that can reach an alert (the others fail matching). */
export type AlertLocationClass = Extract<LocationClass, "us" | "us_restricted" | "mx" | "ambiguous">;
export type JobAction = "applied" | "skipped";

export interface JobAlert {
  title: string;
  companyName: string;
  locationText: string;
  locationClass: AlertLocationClass;
  locationReason?: string;
  /** A US alert whose posting also lists a remote-Mexico location. */
  alsoMexico?: boolean;
  salaryText?: string;
  postedAt?: number;
  applyUrl: string;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

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

export function formatJobAlert(job: JobAlert, now: number): string {
  const mx = job.locationClass === "mx";
  const lines = mx ? ["🇲🇽 <b>MEXICO REMOTE</b>"] : [];
  lines.push(`<b>${field(job.title, MAX_TITLE)}</b>`, `🏢 ${field(job.companyName, MAX_FIELD)}`);

  lines.push(`📍 ${field(job.locationText, MAX_FIELD)}`);
  const reason = job.locationReason?.trim();
  if (mx) {
    if (reason) lines.push(`⚠️ ${field(reason, MAX_REASON)}`);
  } else if (job.locationClass !== "us") {
    lines.push(`⚠️ ${field(reason || "Check location eligibility", MAX_REASON)}`);
  }
  if (job.alsoMexico && (job.locationClass === "us" || job.locationClass === "us_restricted")) {
    lines.push("🇲🇽 Also open to Mexico");
  }

  if (job.salaryText?.trim()) lines.push(`💰 ${field(job.salaryText, MAX_FIELD)}`);

  const ago = formatPostedAgo(job.postedAt, now);
  if (ago) lines.push(`🕒 posted ${ago} ago`);

  lines.push("", `<a href="${escapeHtml(job.applyUrl)}">Apply</a>`, `🔗 ${field(job.applyUrl, MAX_VISIBLE_URL)}`);
  return lines.join("\n");
}

export function jobKeyboard(jobId: number, action?: JobAction): InlineKeyboardMarkup {
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
