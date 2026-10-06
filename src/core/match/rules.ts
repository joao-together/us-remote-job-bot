import type { NormalizedJob } from "../ats/types";
import { MAX_EXCLUDED_WORD_LENGTH } from "../config";

export type LocationClass = "us" | "us_restricted" | "ambiguous" | "non_us" | "onsite";

export interface LocationResult {
  cls: LocationClass;
  reason?: string;
}

export type LocationInput = Pick<NormalizedJob, "locationText" | "remote" | "countryCodes">;
export type MatchInput = Pick<NormalizedJob, "title" | "locationText" | "remote" | "countryCodes">;

export type MatchResult = { pass: true; location: LocationResult } | { pass: false; reason: string };

// ---------- Tokens ----------

/** Lower-cased words split on non-alphanumerics; trailing + and # stay attached so "c++" and "c#" survive. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+[+#]*/gu) ?? [];
}

function indexOfPhrase(tokens: readonly string[], phrase: readonly string[], from = 0): number {
  if (phrase.length === 0) return -1;
  outer: for (let i = from; i + phrase.length <= tokens.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) continue outer;
    }
    return i;
  }
  return -1;
}

/** A phrase pre-split into tokens at module load, so matching never re-splits. */
type Phrases = readonly (readonly string[])[];

function phrases(list: readonly string[]): Phrases {
  return list.map((p) => p.split(" "));
}

function hasAny(tokens: string[], list: Phrases): boolean {
  return list.some((p) => indexOfPhrase(tokens, p) >= 0);
}

// ---------- Role ----------

const ROLE_NOUNS = phrases([
  "engineer", "engineers", "developer", "developers", "swe", "sde", "programmer",
  "tech lead", "technical lead", "team lead", "engineering lead",
]);
const SELF_EXPLANATORY_NOUNS = phrases(["developer", "developers", "swe", "sde", "programmer"]);

const ROLE_HARD_REJECTS = phrases([
  "sales", "presales", "pre sales", "solutions", "support", "customer engineer", "customer success",
  "customer support", "customer facing", "field engineer", "field application", "field applications",
  "manager", "management", "director", "head of", "vp", "vice president", "chief", "cto",
  "recruiter", "recruiting", "in test", "sdet", "qa", "quality assurance", "test automation",
  "developer relations", "advocate", "evangelist", "consultant", "implementation",
  "electrical", "mechanical", "civil", "chemical", "manufacturing", "structural",
]);

/** Product-software areas that win over a specialization ("Full Stack Engineer (AI)"). */
const STRONG_CONTEXT = phrases([
  "backend", "back end", "frontend", "front end", "full stack", "fullstack", "mobile", "ios", "android",
  "web", "product engineer", "product engineers",
]);

/** Software hints that count only when no specialization is named. */
const WEAK_CONTEXT = phrases([
  "software", "platform", "application", "applications", "product", "ui", "api", "saas",
  "java", "python", "ruby", "rails", "go", "golang", "javascript", "typescript", "js", "node", "react",
  "angular", "vue", "php", "net", "dotnet", "c#", "c++", "scala", "kotlin", "swift", "rust", "elixir",
  "django", "flutter",
]);

const SPECIALIZATIONS = phrases([
  "data", "analytics", "etl", "database", "ml", "machine learning", "ai", "artificial intelligence", "llm",
  "mlops", "computer vision", "nlp", "devops", "dev ops", "sre", "site reliability", "reliability",
  "security", "appsec", "test", "testing", "quality", "hardware", "network", "networking", "infrastructure",
  "infra", "embedded", "firmware",
]);

const SENIOR_MARKERS = phrases(["senior", "sr", "snr"]);

export function isSoftwareEngineeringRole(title: string): boolean {
  return isSoftwareEngineeringTokens(tokenize(title));
}

function isSoftwareEngineeringTokens(t: string[]): boolean {
  if (!hasAny(t, ROLE_NOUNS)) return false;
  if (hasAny(t, ROLE_HARD_REJECTS)) return false;
  if (hasAny(t, STRONG_CONTEXT)) return true;
  if (hasAny(t, SPECIALIZATIONS)) return false;
  return hasAny(t, WEAK_CONTEXT) || hasAny(t, SELF_EXPLANATORY_NOUNS);
}

// ---------- Seniority ----------

const SENIORITY_REJECTS = phrases([
  "staff", "principal", "junior", "jr", "intern", "interns", "internship", "graduate", "grad",
  "new grad", "apprentice", "apprenticeship", "trainee", "entry", "early career",
]);
const LEVEL_MARKERS = phrases(["mid", "i", "ii", "iii", "iv", "1", "2", "3", "4"]);

export function isSeniorTitle(title: string): boolean {
  return isSeniorTokens(tokenize(title));
}

function isSeniorTokens(t: string[]): boolean {
  if (hasAny(t, SENIORITY_REJECTS)) return false;
  if (hasAny(t, SENIOR_MARKERS)) return true;
  return t.includes("lead") && !hasAny(t, LEVEL_MARKERS);
}

// ---------- Location ----------

const STATES: Record<string, string> = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO",
  connecticut: "CT", delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID",
  illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME",
  maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO",
  montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA",
  washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY", "district of columbia": "DC",
};
const STATE_CODES = new Set([...Object.values(STATES), "DC"]);
const STATE_PHRASES = Object.entries(STATES).map(([name, code]) => ({ phrase: name.split(" "), code }));
const WASHINGTON_DC = phrases(["washington dc"]);
const WEST_VIRGINIA = phrases(["west virginia"]);
const CANADA = phrases(["canada"]);

const US_TERMS = phrases(["us", "usa", "united states", "united states of america", "north america", "stateside"]);
const US_CITIES = phrases([
  "nyc", "san francisco", "sf", "bay area", "silicon valley", "seattle", "austin", "boston", "chicago",
  "los angeles", "denver", "atlanta", "miami", "dallas", "houston", "san diego", "san jose", "philadelphia",
  "portland", "pittsburgh", "minneapolis", "salt lake city", "raleigh", "nashville", "phoenix",
]);
const NON_US_TERMS = phrases([
  "emea", "apac", "latam", "anz", "dach", "nordics", "benelux", "cee", "europe", "european", "eu", "uk",
  "united kingdom", "england", "scotland", "wales", "ireland", "latin america", "south america",
  "central america", "asia", "africa", "middle east", "canada", "ontario", "quebec", "british columbia",
  "alberta", "mexico", "brazil", "argentina", "colombia", "chile", "peru", "uruguay", "costa rica", "ecuador",
  "india", "pakistan", "bangladesh", "sri lanka", "philippines", "vietnam", "indonesia", "malaysia",
  "thailand", "singapore", "china", "hong kong", "taiwan", "japan", "korea", "australia", "new zealand",
  "israel", "uae", "turkey", "egypt", "nigeria", "kenya", "south africa", "germany", "france", "spain",
  "portugal", "italy", "netherlands", "belgium", "switzerland", "austria", "poland", "czech", "czechia",
  "romania", "bulgaria", "hungary", "greece", "serbia", "croatia", "ukraine", "sweden", "norway", "denmark",
  "finland", "estonia", "latvia", "lithuania", "london", "berlin", "munich", "paris", "dublin", "amsterdam",
  "madrid", "barcelona", "lisbon", "warsaw", "krakow", "zurich", "stockholm", "toronto", "vancouver",
  "montreal", "bangalore", "bengaluru", "hyderabad", "pune", "chennai", "sydney", "melbourne", "tokyo",
  "tel aviv", "sao paulo", "buenos aires", "mexico city",
]);
const CANADIAN_CODES = new Set(["ON", "BC", "QC", "AB", "MB", "SK", "NS", "NB", "NL", "PE"]);
const BROAD_REGIONS = phrases(["americas", "worldwide", "anywhere", "global", "globally"]);
const ONSITE_TERMS = phrases(["hybrid", "onsite", "on site", "in office", "office based"]);

const RANK: Record<LocationClass, number> = { us: 4, us_restricted: 3, ambiguous: 2, non_us: 1, onsite: 0 };

/** Expands dotted abbreviations ("U.S.", "D.C.") so tokenizing doesn't split them into letters. */
function expandAbbreviations(text: string): string {
  return text
    .replace(/\bu\.\s?s\.\s?a\b\.?/gi, " USA ")
    .replace(/\bu\.\s?s\b\.?/gi, " US ")
    .replace(/\bd\.\s?c\b\.?/gi, " DC ");
}

interface Evidence {
  /** Country-level US mention (or US country code). */
  usCountry: boolean;
  states: string[];
  /** Two-letter upper-case codes only; weak because "DE" or "CA" can mean a country. */
  weakStates: boolean;
  usCity: boolean;
  nonUs: boolean;
  broad: boolean;
}

function gatherEvidence(segment: string, countryCodes: string[]): Evidence {
  const t = tokenize(segment);
  const raw = segment.match(/[A-Za-z]+/g) ?? [];

  const americaIdx = t.indexOf("america");
  const bareAmerica =
    americaIdx >= 0 && !["latin", "south", "central"].includes(t[americaIdx - 1] ?? "");
  const usCountry = hasAny(t, US_TERMS) || bareAmerica || countryCodes.includes("US");

  const nonUs =
    hasAny(t, NON_US_TERMS) ||
    raw.some((w) => CANADIAN_CODES.has(w)) ||
    (countryCodes.length > 0 && !countryCodes.includes("US"));

  const fullStates: string[] = [];
  for (const { phrase, code } of STATE_PHRASES) {
    if (indexOfPhrase(t, phrase) >= 0) fullStates.push(code);
  }
  // "Washington DC" names DC, not Washington state; "West Virginia" isn't Virginia.
  if (hasAny(t, WASHINGTON_DC)) remove(fullStates, "WA");
  if (hasAny(t, WEST_VIRGINIA)) remove(fullStates, "VA");

  let codeStates = raw.filter((w) => w.length === 2 && STATE_CODES.has(w));
  if (nonUs && codeStates.includes("CA") && hasAny(t, CANADA)) codeStates = codeStates.filter((c) => c !== "CA");

  const states = [...new Set([...fullStates, ...codeStates])];
  return {
    usCountry,
    states,
    weakStates: fullStates.length === 0 && codeStates.length > 0,
    usCity: hasAny(t, US_CITIES),
    nonUs,
    broad: hasAny(t, BROAD_REGIONS),
  };
}

function remove(list: string[], item: string): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

function classifySegment(segment: string, jobRemote: "yes" | "unknown", countryCodes: string[]): LocationResult {
  const t = tokenize(segment);
  if (hasAny(t, ONSITE_TERMS)) return { cls: "onsite", reason: "Hybrid or on-site" };
  const remote = t.includes("remote") || t.includes("remotely") ? "yes" : jobRemote;
  const ev = gatherEvidence(segment, countryCodes);

  // A lone two-letter code next to a foreign place ("Berlin, DE") isn't US evidence.
  const strongPlace = ev.states.length > 0 && !ev.weakStates;
  const usPlace = strongPlace || ev.usCity || (ev.weakStates && !ev.nonUs);
  const usEvidence = ev.usCountry || usPlace;

  if (remote === "yes") {
    if (usEvidence) {
      const only = t.includes("only") || t.includes("residents");
      if (ev.states.length >= 2 || (only && ev.states.length >= 1)) {
        return { cls: "us_restricted", reason: `Limited to some US states: ${ev.states.join(", ")}` };
      }
      return { cls: "us" };
    }
    if (ev.nonUs) return { cls: "non_us", reason: "Remote outside the US" };
    if (ev.broad) return { cls: "ambiguous", reason: "Location is a broad region; doesn't say US" };
    return { cls: "ambiguous", reason: "Location doesn't say US" };
  }

  // Remote unknown: only a country-wide US location is worth flagging.
  if (ev.nonUs && !ev.usCountry) return { cls: "non_us", reason: "Location outside the US" };
  if (ev.usCountry && !usPlace) {
    return { cls: "ambiguous", reason: "Doesn't say remote; location is just the US" };
  }
  return { cls: "onsite", reason: "no remote signal" };
}

export function classifyLocation(job: LocationInput): LocationResult {
  if (job.remote === "no") return { cls: "onsite", reason: "Not remote" };
  const text = expandAbbreviations(job.locationText);
  const segments = text.split(/\s\/\s|[;|]/).filter((s) => s.trim() !== "");
  if (segments.length === 0) segments.push("");

  let best: LocationResult | undefined;
  for (const segment of segments) {
    const result = classifySegment(segment, job.remote, job.countryCodes);
    if (!best || RANK[result.cls] > RANK[best.cls]) best = result;
  }
  return best!;
}

export function locationPasses(cls: LocationClass): boolean {
  return cls === "us" || cls === "us_restricted" || cls === "ambiguous";
}

// ---------- Excluded words ----------

/**
 * Canonical stored form of an excluded word: its tokens joined by single spaces, so it is exactly
 * what matching compares. Null when it has no letters or digits or is too long.
 */
export function normalizeExcludedWord(word: string): string | null {
  const w = tokenize(word).join(" ");
  if (w === "" || w.length > MAX_EXCLUDED_WORD_LENGTH) return null;
  return w;
}

/** Tokenizes an excluded-word list once, for repeated findExcludedWord calls. Empty phrases are dropped. */
export function prepareExcludedWords(words: readonly string[]): string[][] {
  return words.map(tokenize).filter((p) => p.length > 0);
}

/**
 * Returns the first word/phrase found as whole tokens in text, or null. Words with no letters or digits
 * never match. Accepts raw words (returned as given) or a prepareExcludedWords list (returned as the
 * space-joined tokens, which is the canonical stored form).
 */
export function findExcludedWord(text: string, words: readonly string[] | readonly (readonly string[])[]): string | null {
  const tokens = tokenize(text);
  for (const word of words) {
    const phrase = typeof word === "string" ? tokenize(word) : word;
    if (phrase.length > 0 && indexOfPhrase(tokens, phrase) >= 0) return typeof word === "string" ? word : phrase.join(" ");
  }
  return null;
}

// ---------- Titles ----------

export function normalizeTitle(title: string): string {
  return tokenize(title).join(" ");
}

export function matchesTarget(job: MatchInput): MatchResult {
  const title = tokenize(job.title);
  if (!isSoftwareEngineeringTokens(title)) return { pass: false, reason: "Not a software engineering role" };
  if (!isSeniorTokens(title)) return { pass: false, reason: "Not a senior title" };
  const location = classifyLocation(job);
  if (!locationPasses(location.cls)) {
    return { pass: false, reason: location.reason ?? `Location is ${location.cls}` };
  }
  return { pass: true, location };
}
