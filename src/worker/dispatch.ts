import { REQUEST_TIMEOUT_MS, USER_AGENT } from "../core/config";
import { errorMessage, redactSecrets } from "../core/util";

/** Cron that starts the GitHub Actions poller (GitHub's own scheduler is unreliable). */
export const POLL_CRON = "*/10 * * * *";
/** Cron that runs the health watchdog. */
export const WATCHDOG_CRON = "43 * * * *";
/** Cron that starts the weekly company-list expansion (Mondays 06:00 UTC). */
export const EXPAND_CRON = "0 6 * * 1";
/** Cron that sends each recipient's daily report: 12:00 UTC = 09:00 Brazil time (UTC-3). */
export const REPORT_CRON = "0 12 * * *";

export const POLL_WORKFLOW = "poll.yml";
export const EXPAND_WORKFLOW = "expand-companies.yml";

export interface DispatchConfig {
  token?: string;
  repo?: string;
  ref?: string;
}

/**
 * Starts `workflow` (a file name under .github/workflows) via GitHub's workflow_dispatch API,
 * with the workflow's default inputs. Returns false (and logs) when unconfigured or when GitHub
 * rejects the request.
 */
export async function dispatchWorkflow(cfg: DispatchConfig, workflow: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!cfg.token || !cfg.repo) {
    console.log(`dispatch ${workflow}: GITHUB_DISPATCH_TOKEN or GITHUB_REPO not set; skipping`);
    return false;
  }
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
    console.error(`dispatch ${workflow}: GitHub returned ${res.status}: ${redactSecrets(text.slice(0, 200), cfg.token)}`);
    return false;
  } catch (err) {
    console.error(`dispatch ${workflow}: request failed: ${redactSecrets(errorMessage(err), cfg.token)}`);
    return false;
  }
}

/** Starts the poller workflow. */
export function dispatchPoll(cfg: DispatchConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  return dispatchWorkflow(cfg, POLL_WORKFLOW, fetcher);
}
