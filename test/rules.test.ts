import { describe, expect, it } from "vitest";
import type { RemoteSignal } from "../src/core/ats/types";
import { MAX_EXCLUDED_WORD_LENGTH } from "../src/core/config";
import {
  classifyLocation,
  findExcludedWord,
  isEligibleLevel,
  isSeniorTitle,
  isSoftwareEngineeringRole,
  locationPasses,
  matchesTarget,
  normalizeExcludedWord,
  normalizeTitle,
  prepareExcludedWords,
  type LocationClass,
} from "../src/core/match/rules";

function loc(locationText: string, remote: RemoteSignal = "yes", countryCodes: string[] = []) {
  return classifyLocation({ locationText, remote, countryCodes });
}

function job(title: string, locationText: string, remote: RemoteSignal = "yes", countryCodes: string[] = []) {
  return { title, locationText, remote, countryCodes };
}

describe("plan scenarios", () => {
  it("Covers AE1. 'Remote' with a matching title is ambiguous and flagged", () => {
    const result = matchesTarget(job("Senior Backend Engineer", "Remote"));
    expect(result).toEqual({
      pass: true,
      location: { cls: "ambiguous", reason: "Location doesn't say US" },
    });
  });

  it("Covers AE2. 'Remote – EMEA' is non_us", () => {
    expect(loc("Remote – EMEA").cls).toBe("non_us");
    expect(matchesTarget(job("Senior Backend Engineer", "Remote – EMEA")).pass).toBe(false);
  });

  it("Covers AE3 (widened). Staff and Sr. Frontend are both accepted", () => {
    expect(matchesTarget(job("Staff Software Engineer, Remote US", "Remote US")).pass).toBe(true);
    expect(matchesTarget(job("Sr. Frontend Engineer", "Remote US"))).toEqual({
      pass: true,
      location: { cls: "us" },
    });
  });

  it("accepts Senior Staff and Senior Principal", () => {
    expect(isEligibleLevel("Senior Staff Software Engineer")).toBe(true);
    expect(isEligibleLevel("Senior Principal Engineer")).toBe(true);
  });

  it("keeps isSeniorTitle as an alias of isEligibleLevel", () => {
    expect(isSeniorTitle).toBe(isEligibleLevel);
  });

  it("Covers AE4. 'clearance' excludes a description requiring security clearance", () => {
    const words = [normalizeExcludedWord("Clearance")!];
    expect(findExcludedWord("Active security clearance required for this role.", words)).toBe("clearance");
  });

  it("US with listed states is us_restricted; US or Canada is us", () => {
    expect(loc("Remote – US (CA, NY, TX only)")).toEqual({
      cls: "us_restricted",
      reason: "Limited to some US states: CA, NY, TX",
    });
    expect(loc("Remote (US or Canada)").cls).toBe("us");
  });

  it("Greenhouse unknown remote plus 'United States' is ambiguous, not onsite", () => {
    const result = loc("United States", "unknown");
    expect(result.cls).toBe("ambiguous");
    expect(result.reason).toBeTruthy();
  });

  it("rejects sales engineer and engineering manager, accepts Lead iOS Developer", () => {
    expect(matchesTarget(job("Senior Sales Engineer", "Remote - US")).pass).toBe(false);
    expect(matchesTarget(job("Senior Engineering Manager", "Remote - US")).pass).toBe(false);
    expect(matchesTarget(job("Lead iOS Developer", "Remote - US")).pass).toBe(true);
  });

  it("hybrid with a US location is onsite", () => {
    expect(loc("Hybrid - New York, NY", "unknown").cls).toBe("onsite");
    expect(loc("San Francisco, CA (Hybrid)", "yes").cls).toBe("onsite");
  });

  it("'go' doesn't match 'Google'; '(' and '*' neither throw nor match", () => {
    expect(findExcludedWord("Experience at Google is a plus", ["go"])).toBeNull();
    expect(findExcludedWord("We write Go every day", ["go"])).toBe("go");
    const text = "Build (great) things * with us.";
    expect(() => findExcludedWord(text, ["(", "*", "(.*", "[a-z]+"])).not.toThrow();
    expect(findExcludedWord(text, ["(", "*", "(.*", "[a-z]+"])).toBeNull();
  });
});

describe("isSoftwareEngineeringRole + isEligibleLevel", () => {
  // [title, expected, category]
  const titles: [string, boolean, string][] = [
    // Levels: everything except junior/entry.
    ["Senior Software Engineer", true, "senior"],
    ["Sr. Software Engineer", true, "senior"],
    ["Snr Backend Engineer", true, "senior"],
    ["Staff Software Engineer", true, "staff"],
    ["Senior Staff Software Engineer", true, "senior staff"],
    ["Principal Software Engineer", true, "principal"],
    ["Distinguished Engineer, Platform", true, "distinguished"],
    ["Lead iOS Developer", true, "lead"],
    ["Tech Lead, Payments", true, "tech lead"],
    ["Backend Team Lead", true, "team lead"],
    ["Software Engineer II", true, "mid II"],
    ["Software Engineer III", true, "mid III"],
    ["Software Engineer IV, Backend", true, "mid IV"],
    ["Software Engineer 2", true, "mid 2"],
    ["Software Engineer (L3)", true, "mid L3"],
    ["Mid-Level Frontend Engineer", true, "mid"],
    ["Lead Software Engineer II", true, "lead + level"],
    ["Software Engineer I/II", true, "range incl. mid"],
    ["Senior Software Engineer I", true, "senior sub-level"],
    ["Software Engineer", true, "unleveled"],
    ["Backend Engineer", true, "unleveled"],
    ["Senior Developer", true, "developer alone"],
    ["Junior Frontend Developer", false, "junior"],
    ["Jr. Software Engineer", false, "jr"],
    ["Software Engineering Intern", false, "intern"],
    ["Software Engineer Internship (Summer 2027)", false, "internship"],
    ["Entry-Level Software Engineer", false, "entry level"],
    ["Software Engineer, New Grad", false, "new grad"],
    ["Senior Software Engineer (New Grad)", false, "new grad beats senior"],
    ["Graduate Software Engineer", false, "graduate"],
    ["Early Career Software Engineer", false, "early career"],
    ["Software Engineer Apprentice", false, "apprentice"],
    ["Trainee Software Developer", false, "trainee"],
    ["Software Engineer I", false, "level I"],
    ["Software Engineer 1, Backend", false, "level 1"],
    ["SDE I", false, "SDE I"],
    ["Software Engineer - Level 1", false, "level 1"],
    ["Software Engineer (L1)", false, "L1"],
    ["Associate Software Engineer", false, "associate"],
    // Software and adjacent roles.
    ["Senior Back-End Developer", true, "backend"],
    ["Senior Full-Stack Engineer (AI)", true, "full stack"],
    ["Senior Front End Engineer, Design Systems", true, "frontend"],
    ["Senior Mobile Engineer (React Native)", true, "mobile"],
    ["Senior Python Engineer", true, "language"],
    ["Senior Product Engineer", true, "product"],
    ["Senior DevOps Engineer", true, "devops"],
    ["Senior Site Reliability Engineer", true, "sre"],
    ["Staff SRE", true, "sre"],
    ["Senior Platform Engineer", true, "platform"],
    ["Senior Infrastructure Engineer", true, "infrastructure"],
    ["Cloud Engineer", true, "cloud"],
    ["Senior Software Systems Engineer", true, "systems (software)"],
    ["Distributed Systems Engineer", true, "systems (software)"],
    ["Senior Data Engineer", true, "data"],
    ["Analytics Engineer", true, "analytics"],
    ["Senior Machine Learning Engineer", true, "ml"],
    ["ML Engineer II", true, "ml"],
    ["AI Engineer", true, "ai"],
    ["Senior MLOps Engineer", true, "mlops"],
    ["Applied ML Engineer", true, "applied ml"],
    ["Data Scientist / Machine Learning Engineer", true, "scientist + engineer"],
    ["Senior Security Engineer", true, "security"],
    ["Application Security Engineer", true, "appsec"],
    ["Cloud Security Engineer", true, "cloud security"],
    ["Developer Productivity Engineer", true, "dev productivity"],
    ["Senior Build Engineer", true, "build"],
    ["Release Engineer", true, "release"],
    ["Senior Software Engineer, Machine Learning", true, "ml"],
    // Still rejected.
    ["Senior Engineering Manager", false, "manager"],
    ["Director of Engineering", false, "director"],
    ["Head of Engineering", false, "head of"],
    ["VP of Engineering", false, "vp"],
    ["Senior Sales Engineer", false, "sales"],
    ["Senior Solutions Engineer", false, "solutions"],
    ["Senior Customer Engineer", false, "customer"],
    ["Technical Support Engineer", false, "support"],
    ["Field Engineer", false, "field"],
    ["Implementation Engineer", false, "implementation"],
    ["Professional Services Engineer", false, "professional services"],
    ["Senior QA Engineer", false, "qa"],
    ["Senior Software Engineer in Test", false, "in test"],
    ["SDET II", false, "sdet"],
    ["Test Automation Engineer", false, "test"],
    ["Senior Hardware Engineer", false, "hardware"],
    ["Electrical Engineer", false, "electrical"],
    ["Mechanical Engineer", false, "mechanical"],
    ["Firmware Engineer", false, "firmware"],
    ["Embedded Software Engineer", false, "embedded"],
    ["RF Engineer", false, "rf"],
    ["Manufacturing Engineer", false, "manufacturing"],
    ["Senior Data Analyst", false, "analyst"],
    ["Business Analyst", false, "analyst"],
    ["Senior Data Scientist", false, "scientist"],
    ["Research Scientist, LLMs", false, "scientist"],
    ["Senior Product Designer", false, "designer"],
    ["Senior Product Manager", false, "pm"],
    ["Technical Recruiter", false, "recruiter"],
    ["Senior Network Engineer", false, "network"],
    ["Network Infrastructure Engineer", false, "network"],
    ["Senior Systems Engineer", false, "systems (no software)"],
    ["IT Support Engineer", false, "it support"],
    ["Help Desk Engineer", false, "help desk"],
    ["Senior Engineer", false, "no area"],
    ["Team Lead", false, "no area"],
  ];

  it.each(titles)("%s -> %s (%s)", (title, expected) => {
    expect(isSoftwareEngineeringRole(title) && isEligibleLevel(title)).toBe(expected);
  });

  it("covers at least 40 titles", () => {
    expect(titles.length).toBeGreaterThanOrEqual(40);
  });

  it("separates the role and level checks", () => {
    expect(isEligibleLevel("Team Lead")).toBe(true);
    expect(isSoftwareEngineeringRole("Team Lead")).toBe(false);
    expect(isSoftwareEngineeringRole("Junior Software Engineer")).toBe(true);
    expect(isEligibleLevel("Junior Software Engineer")).toBe(false);
    expect(isSoftwareEngineeringRole("Senior Engineering Manager")).toBe(false);
    expect(isEligibleLevel("Senior Engineering Manager")).toBe(true);
  });

  it("reads I and 1 as a level only right after a role noun or 'Level'", () => {
    expect(isEligibleLevel("Backend Engineer, Team 1")).toBe(true);
    expect(isEligibleLevel("Engineer 1")).toBe(false);
    expect(isEligibleLevel("Level 1 Developer")).toBe(false);
  });
});

describe("classifyLocation", () => {
  const cases: [string, RemoteSignal, string[], LocationClass][] = [
    ["Remote", "yes", [], "ambiguous"],
    ["Remote", "unknown", [], "ambiguous"],
    ["Worldwide", "yes", [], "ambiguous"],
    ["Remote - Americas", "yes", [], "ambiguous"],
    ["Remote - US", "unknown", [], "us"],
    ["Remote, USA", "yes", [], "us"],
    ["Remote (U.S.)", "yes", [], "us"],
    ["United States", "yes", [], "us"],
    ["Remote - North America", "yes", [], "us"],
    ["Remote - NY", "yes", [], "us"],
    ["Remote - Texas", "yes", [], "us"],
    ["San Francisco, CA", "yes", [], "us"],
    ["Remote", "yes", ["US"], "us"],
    ["London, UK / New York, NY", "yes", [], "us"],
    ["Remote - US; Remote - Canada", "yes", [], "us"],
    ["Remote in CA, NY or TX", "yes", [], "us_restricted"],
    ["US Remote (Washington, Oregon only)", "yes", [], "us_restricted"],
    ["Remote – EMEA", "yes", [], "non_us"],
    ["Remote - Canada", "yes", [], "non_us"],
    ["Remote, LATAM", "yes", [], "mx"],
    ["Remote - Latin America", "yes", [], "mx"],
    ["Bengaluru, India", "unknown", [], "non_us"],
    ["Berlin, DE", "yes", [], "non_us"],
    ["Toronto, ON, CA", "yes", [], "non_us"],
    ["Remote", "yes", ["GB"], "non_us"],
    ["United Kingdom", "unknown", [], "non_us"],
    ["USA", "unknown", [], "ambiguous"],
    ["New York, NY", "unknown", [], "onsite"],
    ["", "unknown", [], "onsite"],
    ["Remote - US", "no", [], "onsite"],
    ["Hybrid - Austin, TX", "yes", [], "onsite"],
    ["On-site - Seattle, WA", "unknown", [], "onsite"],
    ["In-office, Boston", "unknown", [], "onsite"],
    ["Hybrid - NYC / Remote - US", "yes", [], "us"],
  ];

  it.each(cases)("%j (remote %s, codes %j) -> %s", (text, remote, codes, expected) => {
    expect(loc(text, remote, codes).cls).toBe(expected);
  });

  it("gives a reason when unknown remote has no signal", () => {
    expect(loc("", "unknown")).toEqual({ cls: "onsite", reason: "no remote signal" });
  });

  it("passes us, us_restricted, mx and ambiguous only", () => {
    expect(locationPasses("us")).toBe(true);
    expect(locationPasses("mx")).toBe(true);
    expect(locationPasses("us_restricted")).toBe(true);
    expect(locationPasses("ambiguous")).toBe(true);
    expect(locationPasses("non_us")).toBe(false);
    expect(locationPasses("onsite")).toBe(false);
  });
});

describe("Mexico-remote locations", () => {
  // [text, remote, codes, expected class, alsoMexico]
  const cases: [string, RemoteSignal, string[], LocationClass, boolean][] = [
    ["Remote - Mexico", "unknown", [], "mx", false],
    ["Remote - Mexico", "yes", [], "mx", false],
    ["Mexico (Remote)", "unknown", [], "mx", false],
    ["Remote - México", "unknown", [], "mx", false],
    ["Remote, MX", "unknown", [], "mx", false],
    ["Remote", "yes", ["MX"], "mx", false],
    ["Mexico", "yes", [], "mx", false],
    ["CDMX - Remote", "unknown", [], "mx", false],
    ["Ciudad de México (Remote)", "unknown", [], "mx", false],
    ["Guadalajara, Jalisco (Remote)", "unknown", [], "mx", false],
    ["Monterrey, Nuevo León - Remote", "unknown", [], "mx", false],
    ["Remote - Querétaro", "unknown", [], "mx", false],
    ["Remote - LATAM", "unknown", [], "mx", false],
    ["Latin America - Remote", "unknown", [], "mx", false],
    ["Remoto - Latinoamérica / Remote", "unknown", [], "mx", false],
    ["Remote – LATAM / Remote", "unknown", [], "mx", false],
    ["Remote - LATAM / EMEA", "unknown", [], "mx", false],
    ["Remote - Canada / Mexico", "unknown", [], "mx", false],
    ["Remote - Canada / Mexico", "yes", [], "mx", false],
    ["Remote - Brazil", "unknown", [], "non_us", false],
    ["Remote - Colombia", "yes", [], "non_us", false],
    ["Mexico City", "unknown", [], "onsite", false],
    ["Mexico", "unknown", [], "onsite", false],
    ["Guadalajara, Jalisco", "unknown", [], "onsite", false],
    ["Hybrid - Mexico City", "yes", [], "onsite", false],
    ["Albuquerque, New Mexico", "unknown", [], "onsite", false],
    ["Albuquerque, NM", "unknown", [], "onsite", false],
    ["Remote - New Mexico", "unknown", [], "us", false],
    ["Remote - NM", "unknown", [], "us", false],
    ["Remote - US / Remote - Mexico", "unknown", [], "us", true],
    ["Remote - US / Mexico", "unknown", [], "us", true],
    ["Remote (US or Mexico)", "unknown", [], "us", true],
    ["Remote", "yes", ["US", "MX"], "us", true],
    ["Remote - CA, NY only / Remote - Mexico", "unknown", [], "us_restricted", true],
    ["Remote - US / Remote - LATAM", "unknown", [], "us", false],
    ["Remote - US / Hybrid - Mexico City", "unknown", [], "us", false],
    ["Remote - New Mexico / Remote - US", "unknown", [], "us", false],
  ];

  it.each(cases)("%j (remote %s, codes %j) -> %s, alsoMexico %s", (text, remote, codes, expected, alsoMexico) => {
    const result = loc(text, remote, codes);
    expect(result.cls).toBe(expected);
    expect(result.alsoMexico ?? false).toBe(alsoMexico);
  });

  it("covers at least 25 location strings", () => {
    expect(cases.length).toBeGreaterThanOrEqual(25);
  });

  it("gives LATAM a check-eligibility reason and plain Mexico none", () => {
    expect(loc("Remote - LATAM", "unknown")).toEqual({ cls: "mx", reason: "LATAM — check Mexico is eligible" });
    expect(loc("Remote - Mexico", "unknown")).toEqual({ cls: "mx" });
    expect(loc("Remote - US / Remote - Mexico", "unknown")).toEqual({ cls: "us", alsoMexico: true });
  });

  it("passes a senior remote-Mexico engineering role and still rejects a junior one", () => {
    expect(matchesTarget(job("Senior Software Engineer", "Remote - Mexico", "unknown"))).toEqual({
      pass: true,
      location: { cls: "mx" },
    });
    expect(matchesTarget(job("Junior Software Engineer", "Remote - Mexico")).pass).toBe(false);
    expect(matchesTarget(job("Senior Software Engineer", "Mexico City", "unknown")).pass).toBe(false);
  });
});

describe("excluded words", () => {
  it("normalizes and validates words", () => {
    expect(normalizeExcludedWord("  Clearance ")).toBe("clearance");
    expect(normalizeExcludedWord("   ")).toBeNull();
    expect(normalizeExcludedWord("x".repeat(MAX_EXCLUDED_WORD_LENGTH))).toBe("x".repeat(MAX_EXCLUDED_WORD_LENGTH));
    expect(normalizeExcludedWord("x".repeat(MAX_EXCLUDED_WORD_LENGTH + 1))).toBeNull();
  });

  it("canonicalizes to space-joined tokens", () => {
    expect(normalizeExcludedWord("  Security   CLEARANCE ")).toBe("security clearance");
    expect(normalizeExcludedWord("On-Call")).toBe("on call");
    expect(normalizeExcludedWord("C#")).toBe("c#");
    expect(normalizeExcludedWord("-- !! --")).toBeNull();
  });

  it("matches a prepared list the same as raw words", () => {
    const prepared = prepareExcludedWords(["on call", "c#", "!!"]);
    expect(prepared).toEqual([["on", "call"], ["c#"]]);
    expect(findExcludedWord("Weekly on-call rotation", prepared)).toBe("on call");
    expect(findExcludedWord("We use C# daily", prepared)).toBe("c#");
    expect(findExcludedWord("Nothing here", prepared)).toBeNull();
  });

  it("matches whole words case-insensitively", () => {
    expect(findExcludedWord("Must hold an active CLEARANCE.", ["clearance"])).toBe("clearance");
    expect(findExcludedWord("Clearances not needed", ["clearance"])).toBeNull();
    expect(findExcludedWord("We use Java and Kotlin", ["javascript", "kotlin"])).toBe("kotlin");
  });

  it("matches multi-word phrases on consecutive words", () => {
    expect(findExcludedWord("A security  clearance is required", ["security clearance"])).toBe("security clearance");
    expect(findExcludedWord("Security is key; clearance not needed", ["security clearance"])).toBeNull();
  });

  it("keeps + and # attached", () => {
    expect(findExcludedWord("Strong C++ skills", ["c++"])).toBe("c++");
    expect(findExcludedWord("Strong C skills", ["c++"])).toBeNull();
    expect(findExcludedWord("Experience with C# and .NET", ["c#"])).toBe("c#");
    expect(findExcludedWord("Experience with C and Python", ["c#"])).toBeNull();
  });

  it("returns null for no words", () => {
    expect(findExcludedWord("anything", [])).toBeNull();
  });
});

describe("normalizeTitle", () => {
  it("lower-cases and collapses whitespace and punctuation", () => {
    expect(normalizeTitle("  Senior   Software Engineer - Backend (Remote) ")).toBe(
      "senior software engineer backend remote",
    );
    expect(normalizeTitle("Sr. C++ Engineer")).toBe("sr c++ engineer");
  });
});

describe("matchesTarget", () => {
  it("explains role, level and location rejections", () => {
    expect(matchesTarget(job("Senior Data Analyst", "Remote - US"))).toEqual({
      pass: false,
      reason: "Not a target engineering role",
    });
    expect(matchesTarget(job("Junior Software Engineer", "Remote - US"))).toEqual({
      pass: false,
      reason: "Junior or entry-level title",
    });
    const onsite = matchesTarget(job("Senior Software Engineer", "Austin, TX", "no"));
    expect(onsite.pass).toBe(false);
  });

  it("flags restricted US remote with a reason", () => {
    expect(matchesTarget(job("Senior Software Engineer", "Remote in CA, NY or TX"))).toEqual({
      pass: true,
      location: { cls: "us_restricted", reason: "Limited to some US states: CA, NY, TX" },
    });
  });
});
