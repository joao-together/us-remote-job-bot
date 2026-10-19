// Tiny helpers shared across the poller, worker and clients.
import { ACTIVE_HOURS_UTC } from "./config";

export const REDACTED = "[redacted]";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Replaces every occurrence of each non-empty secret with "[redacted]". */
export function redactSecrets(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join(REDACTED);
  }
  return out;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const HOUR_MS = 60 * 60 * 1000;

/**
 * Start (epoch ms) of the polling window (ACTIVE_HOURS_UTC) that contains `at`, or undefined when
 * `at` is outside active hours.
 */
export function activeWindowStart(at: number, hours: { start: number; end: number } = ACTIVE_HOURS_UTC): number | undefined {
  const d = new Date(at);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const start = midnight + hours.start * HOUR_MS;
  return at >= start && at < midnight + hours.end * HOUR_MS ? start : undefined;
}

/** Whether `at` falls inside ACTIVE_HOURS_UTC. */
export function inActiveHours(at: number): boolean {
  return activeWindowStart(at) !== undefined;
}

/** D1 rejects `undefined` and booleans; map them to SQL-friendly values. */
export function normalizeParams(params: unknown[] | undefined): unknown[] {
  return (params ?? []).map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : p));
}
