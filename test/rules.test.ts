import { describe, expect, it } from "vitest";
import type { RemoteSignal } from "../src/core/ats/types";
import { MAX_EXCLUDED_WORD_LENGTH } from "../src/core/config";
import {
  classifyLocation,
  findExcludedWord,
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

  it("Covers AE3. Staff is rejected, Sr. Frontend is accepted", () => {
    expect(matchesTarget(job("Staff Software Engineer, Remote US", "Remote US")).pass).toBe(false);
    expect(matchesTarget(job("Sr. Frontend Engineer", "Remote US"))).toEqual({
      pass: true,
      location: { cls: "us" },
    });
  });

  it("rejects Senior Staff and Senior Principal", () => {
    expect(isSeniorTitle("Senior Staff Software Engineer")).toBe(false);
    expect(isSeniorTitle("Senior Principal Engineer")).toBe(false);
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

describe("isSoftwareEngineeringRole + isSeniorTitle", () => {
  const titles: [string, boolean][] = [
    ["Senior Software Engineer", true],
    ["Sr. Software Engineer", true],
    ["Sr Backend Engineer", true],
    ["Senior Back-End Developer", true],
    ["Senior Full-Stack Engineer (AI)", true],
    ["Senior Fullstack Developer", true],
    ["Senior Front End Engineer, Design Systems", true],
    ["Senior Android Engineer", true],
    ["Senior Mobile Engineer (React Native)", true],
    ["Lead iOS Developer", true],
    ["Senior Platform Engineer", true],
    ["Senior Product Engineer", true],
    ["Senior Software Engineer II", true],
    ["Senior Python Engineer", true],
    ["Senior Web Developer", true],
    ["Backend Team Lead", true],
    ["Senior Backend Engineer, Machine Learning Platform", true],
    ["Software Engineer", false],
    ["Software Engineer III", false],
    ["Mid-Level Frontend Engineer", false],
    ["Lead Software Engineer II", false],
    ["Junior Frontend Developer", false],
    ["Senior Software Engineer (New Grad)", false],
    ["Software Engineering Intern", false],
    ["Staff Backend Engineer", false],
    ["Principal Software Engineer", false],
    ["Senior Machine Learning Engineer", false],
    ["Senior Software Engineer, Machine Learning", false],
    ["Senior Data Engineer", false],
    ["Senior DevOps Engineer", false],
    ["Senior Site Reliability Engineer", false],
    ["Senior Security Engineer", false],
    ["Senior Software Engineer in Test", false],
    ["Senior QA Engineer", false],
    ["Senior Solutions Engineer", false],
    ["Senior Customer Engineer", false],
    ["Senior Infrastructure Engineer", false],
    ["Senior Hardware Engineer", false],
    ["Director of Engineering", false],
    ["Head of Engineering", false],
    ["Senior Engineer", false],
    ["Team Lead", false],
    ["Senior Product Manager", false],
  ];

  it.each(titles)("%s -> %s", (title, expected) => {
    expect(isSoftwareEngineeringRole(title) && isSeniorTitle(title)).toBe(expected);
  });

  it("'Team Lead' counts as Lead for seniority", () => {
    expect(isSeniorTitle("Team Lead")).toBe(true);
    expect(isSoftwareEngineeringRole("Team Lead")).toBe(false);
  });

  it("separates the role and seniority checks", () => {
    expect(isSoftwareEngineeringRole("Software Engineer")).toBe(true);
    expect(isSeniorTitle("Software Engineer")).toBe(false);
    expect(isSoftwareEngineeringRole("Staff Software Engineer")).toBe(true);
    expect(isSeniorTitle("Staff Software Engineer")).toBe(false);
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
    ["Remote, LATAM", "yes", [], "non_us"],
    ["Remote - Latin America", "yes", [], "non_us"],
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

  it("passes us, us_restricted and ambiguous only", () => {
    expect(locationPasses("us")).toBe(true);
    expect(locationPasses("us_restricted")).toBe(true);
    expect(locationPasses("ambiguous")).toBe(true);
    expect(locationPasses("non_us")).toBe(false);
    expect(locationPasses("onsite")).toBe(false);
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
  it("explains role, seniority and location rejections", () => {
    expect(matchesTarget(job("Senior Data Engineer", "Remote - US"))).toEqual({
      pass: false,
      reason: "Not a software engineering role",
    });
    expect(matchesTarget(job("Software Engineer", "Remote - US"))).toEqual({
      pass: false,
      reason: "Not a senior title",
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
