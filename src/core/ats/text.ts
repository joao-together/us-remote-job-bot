// Small text helpers shared by the board adapters (no HTML parser dependency).

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  hellip: "…",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
};

/** Decodes one level of HTML entities (named subset plus numeric). Unknown entities are kept. */
export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Converts an HTML fragment to readable plain text. */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/(p|div|ul|ol|h[1-6]|tr|section|blockquote)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  return decodeEntities(text)
    .replace(/ /g, " ")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function groupThousands(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  const [int = "0", frac] = String(rounded).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac ? `${grouped}.${frac.padEnd(2, "0")}` : grouped;
}

/** "$170,000–$210,000 USD"; non-USD amounts get no symbol, e.g. "60,000–80,000 EUR". */
export function formatMoneyRange(min: number | undefined, max: number | undefined, currency?: string): string | undefined {
  const cur = (currency ?? "").trim().toUpperCase();
  const symbol = cur === "USD" ? "$" : "";
  const fmt = (n: number) => `${symbol}${groupThousands(n)}`;
  const lo = typeof min === "number" && Number.isFinite(min) ? min : undefined;
  const hi = typeof max === "number" && Number.isFinite(max) ? max : undefined;
  let amount: string;
  if (lo !== undefined && hi !== undefined) amount = lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
  else if (lo !== undefined) amount = `from ${fmt(lo)}`;
  else if (hi !== undefined) amount = `up to ${fmt(hi)}`;
  else return undefined;
  return cur ? `${amount} ${cur}` : amount;
}

const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  "u.s.": "US",
  "u.s.a.": "US",
  canada: "CA",
  mexico: "MX",
  brazil: "BR",
  "united kingdom": "GB",
  uk: "GB",
  ireland: "IE",
  france: "FR",
  germany: "DE",
  netherlands: "NL",
  spain: "ES",
  portugal: "PT",
  italy: "IT",
  poland: "PL",
  sweden: "SE",
  switzerland: "CH",
  austria: "AT",
  israel: "IL",
  india: "IN",
  singapore: "SG",
  japan: "JP",
  "south korea": "KR",
  australia: "AU",
};

/** Maps a country field (ISO-2 code or common name) to an upper-case ISO-2 code. */
export function countryCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  return COUNTRY_NAMES[v.toLowerCase()];
}

/**
 * Country codes named in free location text such as "Remote, Canada; Remote, US".
 * Only full names and US/USA/UK are recognized, so state abbreviations are not mistaken for countries.
 */
export function countriesInText(text: string): string[] {
  const codes = text
    .split(/[;,/|()]| - /)
    .map((part) => part.trim().toLowerCase().replace(/^remote\s+/, ""))
    .map((part) => COUNTRY_NAMES[part])
    .filter((c): c is string => c !== undefined);
  return unique(codes);
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** True when the value is an absolute https URL. */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Epoch ms from an ISO string or epoch number; undefined when missing or invalid. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value === "") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
