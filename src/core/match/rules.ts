import type { NormalizedJob } from "../ats/types";
import { MAX_EXCLUDED_WORD_LENGTH } from "../config";

/** Countries a remote posting can be open to, in display order. */
export const COUNTRIES = ["US", "MX", "CO", "AR"] as const;
export type Country = (typeof COUNTRIES)[number];
/** What a LATAM-wide posting (no country named) counts as when routing alerts. */
export const LATAM_COUNTRIES: readonly Country[] = ["MX", "CO", "AR"];

/**
 * - us / us_restricted: remote in the US (all states / only some); ambiguous: may be US ("Remote").
 * - intl: remote in Mexico, Colombia and/or Argentina, or LATAM-wide, and not in the US.
 * - non_us / onsite: fail matching.
 */
export type LocationClass = "us" | "us_restricted" | "intl" | "ambiguous" | "non_us" | "onsite";

export interface LocationResult {
  cls: LocationClass;
  reason?: string;
  /**
   * Passing classes only: the countries the posting is remote in, in COUNTRIES order. "US" for
   * us, us_restricted and ambiguous; plus MX/CO/AR from any remote location naming them.
   */
  countries?: Country[];
  /** Passing classes only, and only when true: a remote location is LATAM-wide (names no country). */
  latam?: boolean;
}

/** The countries an alert is routed to: its own countries, with LATAM expanded to MX, CO and AR. */
export function routeCountries(countries: readonly Country[], latam: boolean): Set<Country> {
  const out = new Set<Country>(countries);
  if (latam) for (const c of LATAM_COUNTRIES) out.add(c);
  return out;
}

export function isCountry(v: string): v is Country {
  return (COUNTRIES as readonly string[]).includes(v);
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
  "engineer", "engineers", "developer", "developers", "swe", "sde", "programmer", "sre",
  "tech lead", "technical lead", "team lead", "engineering lead",
]);
/** Nouns that name a software role without any further context ("Senior Developer", "Senior SRE", "Tech Lead"). */
const SELF_EXPLANATORY_NOUNS = phrases(["developer", "developers", "swe", "sde", "programmer", "sre", "tech lead"]);

const ROLE_HARD_REJECTS = phrases([
  // Sales, customer-facing and services engineering.
  "sales", "presales", "pre sales", "solutions", "solution", "support", "customer engineer", "customer success",
  "customer support", "customer facing", "customer reliability", "customer experience", "field engineer",
  "field engineering", "field application", "field applications", "field service", "implementation",
  "professional services", "developer relations", "advocate", "evangelist",
  "consultant",
  // Management and recruiting.
  "manager", "management", "director", "head of", "vp", "vice president", "chief", "cto",
  "recruiter", "recruiting",
  // QA and test.
  "in test", "sdet", "qa", "qe", "quality", "quality assurance", "test", "tester", "testing", "test automation",
  // Hardware and physical engineering.
  "hardware", "electrical", "mechanical", "firmware", "embedded", "rf", "manufacturing", "asic", "fpga",
  "silicon", "pcb", "analog", "optical", "photonics", "mechatronics", "avionics", "civil", "chemical",
  "structural", "data center", "datacenter", "facilities",
  // IT support and non-engineering security work.
  "it", "help desk", "helpdesk", "service desk", "physical security",
  // Teaching/content "developers" and data-labeling operations ("Curriculum Developer", "Human Data Operations").
  "curriculum", "course", "courseware", "instructional", "instructor", "trainer", "training developer",
  "content developer", "subject matter", "human data", "data operations", "annotation", "annotator",
  "labeling", "labelling",
]);

/** Product-software areas and adjacent engineering disciplines that count as a target role. */
const ROLE_CONTEXT = phrases([
  // Product software.
  "software", "backend", "back end", "frontend", "front end", "full stack", "fullstack", "mobile", "ios",
  "android", "web", "product", "application", "applications", "ui", "api", "apis", "saas",
  "java", "python", "ruby", "rails", "go", "golang", "javascript", "typescript", "js", "node", "react",
  "angular", "vue", "php", "net", "dotnet", "c#", "c++", "scala", "kotlin", "swift", "rust", "elixir",
  "django", "flutter", "distributed systems",
  // DevOps, SRE, platform and infrastructure.
  "devops", "dev ops", "devsecops", "sre", "site reliability", "reliability", "platform", "infrastructure",
  "infra", "cloud", "kubernetes", "observability", "production",
  // Data and ML/AI.
  "data", "analytics", "etl", "database", "ml", "machine learning", "mlops", "ml ops", "ai",
  "artificial intelligence", "llm", "genai", "deep learning", "computer vision", "nlp", "applied",
  "business intelligence",
  // Security.
  "security", "appsec", "application security", "cloud security", "product security",
  // Developer productivity, build and release.
  "developer productivity", "dev productivity", "developer experience", "devex", "productivity", "tooling",
  "build", "release", "ci",
]);

/**
 * Words that alone don't make a software role: "Systems Engineer" and "Network Engineer" are often
 * IT or hardware jobs. They pass only with other role context ("Software Systems Engineer").
 */
const NEEDS_SOFTWARE_CONTEXT = phrases(["systems", "system", "network", "networking"]);
/** For NEEDS_SOFTWARE_CONTEXT titles, infra and security words don't count ("Network Infrastructure Engineer"). */
const INFRA_ONLY_CONTEXT = new Set(["infrastructure", "infra", "cloud", "reliability", "production", "security"]);

export function isSoftwareEngineeringRole(title: string): boolean {
  return isSoftwareEngineeringTokens(tokenize(title));
}

function isSoftwareEngineeringTokens(t: string[]): boolean {
  if (!hasAny(t, ROLE_NOUNS)) return false;
  if (hasAny(t, ROLE_HARD_REJECTS)) return false;
  const context = ROLE_CONTEXT.filter((p) => indexOfPhrase(t, p) >= 0);
  if (hasAny(t, NEEDS_SOFTWARE_CONTEXT)) {
    // "distributed systems" names the area itself; otherwise need context beyond infrastructure words.
    return context.some((p) => !INFRA_ONLY_CONTEXT.has(p.join(" ")));
  }
  return context.length > 0 || hasAny(t, SELF_EXPLANATORY_NOUNS);
}

// ---------- Seniority ----------

/** Junior, student and entry-level markers: always rejected, even next to "Senior". */
const ENTRY_LEVEL_REJECTS = phrases([
  "junior", "jr", "intern", "interns", "internship", "graduate", "grad", "new grad", "apprentice",
  "apprenticeship", "trainee", "entry", "entry level", "early career", "student", "campus", "university",
  "co op", "coop",
]);
/** Senior-or-above markers; they win over a sub-level ("Senior Software Engineer I") or "Associate". */
const SENIOR_PLUS_MARKERS = phrases([
  "senior", "sr", "snr", "staff", "principal", "distinguished", "lead", "architect",
]);
/** Second-level-or-above markers; their presence means a range like "Engineer I/II" isn't entry-only. */
const HIGHER_LEVEL_MARKERS = phrases(["mid", "ii", "iii", "iv", "v", "2", "3", "4", "5", "l2", "l3", "l4", "l5"]);
/** Tokens that a level number can follow: "Software Engineer I", "SDE 1", "Level 1". */
const LEVEL_HOSTS = new Set(["engineer", "engineers", "developer", "developers", "swe", "sde", "programmer", "level", "lvl", "grade", "tier"]);

function hasFirstLevelMarker(t: string[]): boolean {
  if (t.includes("l1")) return true;
  return t.some((tok, i) => (tok === "i" || tok === "1") && i > 0 && LEVEL_HOSTS.has(t[i - 1]!));
}

/**
 * Whether a title's level is eligible: everything except junior/entry. Accepts Senior, Staff,
 * Principal, Distinguished, Lead, mid-level (II, III, 2, Mid) and unleveled titles; rejects
 * Junior, Intern, Entry-level, Graduate/New Grad, Apprentice, Trainee, first-level markers
 * ("Engineer I", "SDE 1", "Level 1", "L1") and Associate as a level.
 */
export function isEligibleLevel(title: string): boolean {
  return isEligibleLevelTokens(tokenize(title));
}

/** @deprecated Old name from when only Senior/Lead titles passed; use isEligibleLevel. */
export const isSeniorTitle = isEligibleLevel;

function isEligibleLevelTokens(t: string[]): boolean {
  if (hasAny(t, ENTRY_LEVEL_REJECTS)) return false;
  if (hasAny(t, SENIOR_PLUS_MARKERS)) return true;
  if (t.includes("associate")) return false;
  return !hasFirstLevelMarker(t) || hasAny(t, HIGHER_LEVEL_MARKERS);
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
  "alberta", "brazil", "argentina", "colombia", "chile", "peru", "uruguay", "costa rica", "ecuador",
  "india", "pakistan", "bangladesh", "sri lanka", "philippines", "vietnam", "indonesia", "malaysia",
  "thailand", "singapore", "china", "hong kong", "taiwan", "japan", "korea", "australia", "new zealand",
  "israel", "uae", "turkey", "egypt", "nigeria", "kenya", "south africa", "germany", "france", "spain",
  "portugal", "italy", "netherlands", "belgium", "switzerland", "austria", "poland", "czech", "czechia",
  "romania", "bulgaria", "hungary", "greece", "serbia", "croatia", "ukraine", "sweden", "norway", "denmark",
  "finland", "estonia", "latvia", "lithuania", "london", "berlin", "munich", "paris", "dublin", "amsterdam",
  "madrid", "barcelona", "lisbon", "warsaw", "krakow", "zurich", "stockholm", "toronto", "vancouver",
  "montreal", "bangalore", "bengaluru", "hyderabad", "pune", "chennai", "sydney", "melbourne", "tokyo",
  "tel aviv", "sao paulo", "buenos aires",
]);
/**
 * Location text is matched accent-insensitively (see foldAccents), so these lists are unaccented.
 *
 * Mexico by name, city or state. Bare "mexico" is checked separately so "New Mexico" (a US state)
 * never counts; "MX" counts only as an upper-case country token or country code.
 */
const MEXICO_PLACES = phrases([
  "cdmx", "ciudad de mexico", "guadalajara", "monterrey", "queretaro", "puebla", "tijuana", "merida",
  "leon", "jalisco", "nuevo leon",
]);
/**
 * Colombia by name or city. A bare "CO" is Colorado ("Denver, CO", "Remote - US (CO)"); only a
 * structured country code CO (from the board's country field) means Colombia.
 */
const COLOMBIA_PLACES = phrases(["colombia", "bogota", "medellin", "cali", "barranquilla", "cartagena"]);
/**
 * Argentina by name or city. "AR" is Arkansas unless the location is otherwise outside the US
 * (see gatherEvidence); Córdoba (also in Spain and Mexico) counts only in an Argentina/LATAM
 * context or when nothing else in the location names a place.
 */
const ARGENTINA_PLACES = phrases(["argentina", "buenos aires", "caba", "rosario", "mendoza"]);
const CORDOBA = phrases(["cordoba"]);
const LATAM_TERMS = phrases(["latam", "latin america", "latinoamerica", "latino america"]);
const LATAM_REASON = "LATAM — check your country is eligible";
const CANADIAN_CODES = new Set(["ON", "BC", "QC", "AB", "MB", "SK", "NS", "NB", "NL", "PE"]);
const BROAD_REGIONS = phrases(["americas", "worldwide", "anywhere", "global", "globally"]);
const ONSITE_TERMS = phrases(["hybrid", "onsite", "on site", "in office", "office based"]);

const RANK: Record<LocationClass, number> = { us: 5, us_restricted: 4, intl: 3, ambiguous: 2, non_us: 1, onsite: 0 };

/** Expands dotted abbreviations ("U.S.", "D.C.") so tokenizing doesn't split them into letters. */
function expandAbbreviations(text: string): string {
  return text
    .replace(/\bu\.\s?s\.\s?a\b\.?/gi, " USA ")
    .replace(/\bu\.\s?s\b\.?/gi, " US ")
    .replace(/\bd\.\s?c\b\.?/gi, " DC ");
}

/** "Bogotá" -> "Bogota", "Latinoamérica" -> "Latinoamerica" (case is kept). */
function foldAccents(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").normalize("NFC");
}

interface Evidence {
  /** Country-level US mention (or US country code). */
  usCountry: boolean;
  states: string[];
  /** Two-letter upper-case codes only; weak because "DE" or "CA" can mean a country. */
  weakStates: boolean;
  usCity: boolean;
  nonUs: boolean;
  /** MX/CO/AR named explicitly (country, code, city or state), in COUNTRIES order; never "New Mexico". */
  named: Country[];
  /** Latin America as a region. */
  latam: boolean;
  broad: boolean;
}

/** "mexico" anywhere except right after "new" (New Mexico is a US state). */
function namesMexico(t: string[]): boolean {
  return t.some((tok, i) => tok === "mexico" && t[i - 1] !== "new");
}

function gatherEvidence(segment: string, countryCodes: string[]): Evidence {
  const t = tokenize(segment);
  const raw = segment.match(/[A-Za-z]+/g) ?? [];

  const americaIdx = t.indexOf("america");
  const bareAmerica =
    americaIdx >= 0 && !["latin", "south", "central"].includes(t[americaIdx - 1] ?? "");
  const usCountry = hasAny(t, US_TERMS) || bareAmerica || countryCodes.includes("US");

  const mexico = namesMexico(t) || hasAny(t, MEXICO_PLACES) || raw.some((w) => w === "MX") || countryCodes.includes("MX");
  const colombia = hasAny(t, COLOMBIA_PLACES) || countryCodes.includes("CO");
  let argentina = hasAny(t, ARGENTINA_PLACES) || countryCodes.includes("AR");
  const latam = hasAny(t, LATAM_TERMS);
  let nonUs =
    mexico ||
    colombia ||
    argentina ||
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
  const usCity = hasAny(t, US_CITIES);

  let codeStates = raw.filter((w) => w.length === 2 && STATE_CODES.has(w));
  if (nonUs && codeStates.includes("CA") && hasAny(t, CANADA)) codeStates = codeStates.filter((c) => c !== "CA");

  // US markers other than a bare "AR" (Arkansas or Argentina).
  const otherUs = usCountry || usCity || fullStates.length > 0 || codeStates.some((c) => c !== "AR");
  // Córdoba (also in Spain and Mexico): Argentina unless another country or a US marker is named.
  if (hasAny(t, CORDOBA) && !otherUs && (argentina || latam || !nonUs)) argentina = true;
  // "AR" is Arkansas ("Little Rock, AR", "Remote, AR") unless the location is otherwise outside the
  // US with no other US marker ("Remote - LATAM (BR, AR)", "Córdoba, AR").
  if (codeStates.includes("AR") && (nonUs || argentina) && !otherUs) {
    argentina = true;
    codeStates = codeStates.filter((c) => c !== "AR");
  }
  nonUs ||= argentina;

  const states = [...new Set([...fullStates, ...codeStates])];
  const flags: Record<Country, boolean> = { US: false, MX: mexico, CO: colombia, AR: argentina };
  return {
    usCountry,
    states,
    weakStates: fullStates.length === 0 && codeStates.length > 0,
    usCity,
    nonUs,
    named: COUNTRIES.filter((c) => flags[c]),
    latam,
    broad: hasAny(t, BROAD_REGIONS),
  };
}

function remove(list: string[], item: string): void {
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
}

function saysRemote(t: string[]): boolean {
  return t.includes("remote") || t.includes("remotely");
}

interface SegmentResult {
  cls: LocationClass;
  reason?: string;
  /** MX/CO/AR this segment is remote in (empty unless the segment is remote). */
  remoteNamed: Country[];
  /** The segment is remote and LATAM-wide without naming one of the countries. */
  remoteLatam: boolean;
}

/**
 * `textRemote`: some segment of the whole location text says remote. A Mexico/Colombia/Argentina
 * or LATAM segment with no remote word of its own then counts as remote ("Remote - Canada /
 * Mexico"); US segments keep the per-segment rule.
 */
function classifySegment(
  segment: string,
  jobRemote: "yes" | "unknown",
  countryCodes: string[],
  textRemote: boolean,
): SegmentResult {
  const t = tokenize(segment);
  if (hasAny(t, ONSITE_TERMS)) return { cls: "onsite", reason: "Hybrid or on-site", remoteNamed: [], remoteLatam: false };
  const ev = gatherEvidence(segment, countryCodes);
  const latamTarget = ev.named.length > 0 || ev.latam;
  const remote = saysRemote(t) || jobRemote === "yes" || (textRemote && latamTarget) ? "yes" : "unknown";
  const result = classifyEvidence(t, ev, remote);
  const isRemote = remote === "yes";
  return {
    ...result,
    remoteNamed: isRemote ? ev.named : [],
    remoteLatam: isRemote && ev.latam && ev.named.length === 0,
  };
}

function classifyEvidence(t: string[], ev: Evidence, remote: "yes" | "unknown"): Pick<LocationResult, "cls" | "reason"> {
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
    if (ev.named.length > 0 || ev.latam) return { cls: "intl" };
    if (ev.nonUs) return { cls: "non_us", reason: "Remote outside the US" };
    if (ev.broad) return { cls: "ambiguous", reason: "Location is a broad region; doesn't say US" };
    return { cls: "ambiguous", reason: "Location doesn't say US" };
  }

  // Remote unknown: only a country-wide US location is worth flagging. Mexico, Colombia or
  // Argentina without a remote signal is treated like a US city: an office job.
  if (ev.named.length > 0 && !ev.usCountry) return { cls: "onsite", reason: "no remote signal" };
  if (ev.nonUs && !ev.usCountry) return { cls: "non_us", reason: "Location outside the US" };
  if (ev.usCountry && !usPlace) {
    return { cls: "ambiguous", reason: "Doesn't say remote; location is just the US" };
  }
  return { cls: "onsite", reason: "no remote signal" };
}

/**
 * Classifies a posting's location. Several locations ("Remote - US / Remote - Colombia") are
 * classified one by one and the best class wins: us, then us_restricted, then intl, then
 * ambiguous. `countries` then collects US (for a US-eligible result) plus every country named by
 * a remote location, and `latam` any remote LATAM-wide location.
 */
export function classifyLocation(job: LocationInput): LocationResult {
  if (job.remote === "no") return { cls: "onsite", reason: "Not remote" };
  const text = foldAccents(expandAbbreviations(job.locationText.normalize("NFC")));
  const segments = text.split(/\s\/\s|[;|]/).filter((s) => s.trim() !== "");
  if (segments.length === 0) segments.push("");

  const textRemote = saysRemote(tokenize(text));
  let best: SegmentResult | undefined;
  const named = new Set<Country>();
  let latam = false;
  for (const segment of segments) {
    const result = classifySegment(segment, job.remote, job.countryCodes, textRemote);
    for (const c of result.remoteNamed) named.add(c);
    latam ||= result.remoteLatam;
    if (!best || RANK[result.cls] > RANK[best.cls]) best = result;
  }
  const cls = best!.cls;
  if (!locationPasses(cls)) return best!.reason === undefined ? { cls } : { cls, reason: best!.reason };

  if (cls !== "intl") named.add("US");
  const out: LocationResult = { cls, countries: COUNTRIES.filter((c) => named.has(c)) };
  // An intl result only needs a warning when it is LATAM-wide with no country named.
  const reason = cls === "intl" ? (named.size === 0 ? LATAM_REASON : undefined) : best!.reason;
  if (reason !== undefined) out.reason = reason;
  if (latam) out.latam = true;
  return out;
}

export function locationPasses(cls: LocationClass): boolean {
  return cls === "us" || cls === "us_restricted" || cls === "intl" || cls === "ambiguous";
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
  if (!isSoftwareEngineeringTokens(title)) return { pass: false, reason: "Not a target engineering role" };
  if (!isEligibleLevelTokens(title)) return { pass: false, reason: "Junior or entry-level title" };
  const location = classifyLocation(job);
  if (!locationPasses(location.cls)) {
    return { pass: false, reason: location.reason ?? `Location is ${location.cls}` };
  }
  return { pass: true, location };
}
