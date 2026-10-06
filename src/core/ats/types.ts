export type AtsKind = "greenhouse" | "lever" | "ashby" | "workable";

export const ATS_KINDS: readonly AtsKind[] = ["greenhouse", "lever", "ashby", "workable"];

/** Whether a posting is remote: explicit yes/no, or unknown when the board has no remote field. */
export type RemoteSignal = "yes" | "no" | "unknown";

/** A job posting mapped from any board's payload into one shape. */
export interface NormalizedJob {
  /** Board's own stable id for the posting. */
  id: string;
  title: string;
  /** Human-readable location text, possibly several locations joined with " / ". */
  locationText: string;
  remote: RemoteSignal;
  /** ISO-3166 alpha-2 country codes the board reports, upper-case. */
  countryCodes: string[];
  /** Company's own application page; always https. */
  applyUrl: string;
  /** Epoch ms, when the board reports a posting/creation time. */
  postedAt?: number;
  salaryText?: string;
  /** Plain-text description when the list payload includes it. */
  description?: string;
}

/** Extra data fetched per job when the list payload lacks it (Greenhouse, Workable). */
export interface JobDetail {
  description: string;
  salaryText?: string;
}

export type FetchFailureKind = "not_found" | "http_error" | "timeout" | "parse_error";

export interface FetchFailure {
  ok: false;
  kind: FetchFailureKind;
  message: string;
}

export type FetchResult<T> = { ok: true; value: T } | FetchFailure;

export type Fetcher = typeof fetch;

export interface BoardRef {
  ats: AtsKind;
  token: string;
}

export interface AtsAdapter {
  kind: AtsKind;
  listJobs(token: string, fetcher: Fetcher): Promise<FetchResult<NormalizedJob[]>>;
  /** Present only for boards whose list payload omits description or salary. */
  fetchDetail?(token: string, jobId: string, fetcher: Fetcher): Promise<FetchResult<JobDetail>>;
}
