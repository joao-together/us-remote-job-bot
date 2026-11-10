import { REQUEST_TIMEOUT_MS, USER_AGENT } from "../core/config";
import { errorMessage, redactSecrets } from "../core/util";

/**
 * Cron that starts the GitHub Actions poller (GitHub's own scheduler is unreliable): every 15
 * minutes from 08:00 to 23:45 UTC (ACTIVE_HOURS_UTC: 05:00–21:00 Brazil time).
 */
export const POLL_CRON = "*/15 8-23 * * *";
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
  return (await dispatchWorkflowStatus(cfg, workflow, fetcher)) === 204;
}

/**
 * Like dispatchWorkflow, but returns GitHub's HTTP status (204 on success), or null when
 * unconfigured or the request itself failed. 401/403 mean the dispatch token is expired or revoked.
 */
export async function dispatchWorkflowStatus(
  cfg: DispatchConfig,
  workflow: string,
  fetcher: typeof fetch = fetch,
): Promise<number | null> {
  if (!cfg.token || !cfg.repo) {
    console.log(`dispatch ${workflow}: GITHUB_DISPATCH_TOKEN or GITHUB_REPO not set; skipping`);
    return null;
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
    if (res.status === 204) return 204;
    const text = await res.text().catch(() => "");
    console.error(`dispatch ${workflow}: GitHub returned ${res.status}: ${redactSecrets(text.slice(0, 200), cfg.token)}`);
    return res.status;
  } catch (err) {
    console.error(`dispatch ${workflow}: request failed: ${redactSecrets(errorMessage(err), cfg.token)}`);
    return null;
  }
}

/** Starts the poller workflow. */
export function dispatchPoll(cfg: DispatchConfig, fetcher: typeof fetch = fetch): Promise<boolean> {
  return dispatchWorkflow(cfg, POLL_WORKFLOW, fetcher);
}
