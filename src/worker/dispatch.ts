import { REQUEST_TIMEOUT_MS, USER_AGENT } from "../core/config";
import { errorMessage, redactSecrets } from "../core/util";

/** Cron that starts the GitHub Actions poller (GitHub's own scheduler is unreliable). */
export const POLL_CRON = "*/10 * * * *";
/** Cron that runs the health watchdog. */
export const WATCHDOG_CRON = "43 * * * *";

export interface DispatchConfig {
  token?: string;
  repo?: string;
  workflow?: string;
  ref?: string;
}

/**
 * Starts the poller workflow via GitHub's workflow_dispatch API.
 * Returns false (and logs) when unconfigured or when GitHub rejects the request.
 */
export async function dispatchPoll(cfg: DispatchConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!cfg.token || !cfg.repo) {
    console.log("dispatch: GITHUB_DISPATCH_TOKEN or GITHUB_REPO not set; skipping");
    return false;
  }
  const workflow = cfg.workflow ?? "poll.yml";
  const url = `https://api.github.com/repos/${cfg.repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`;
  try {
    const res = await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${cfg.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": USER_AGENT,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ref: cfg.ref ?? "main" }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.status === 204) return true;
    const text = await res.text().catch(() => "");
    console.error(`dispatch: GitHub returned ${res.status}: ${redactSecrets(text.slice(0, 200), cfg.token)}`);
    return false;
  } catch (err) {
    console.error(`dispatch: request failed: ${redactSecrets(errorMessage(err), cfg.token)}`);
    return false;
  }
}
