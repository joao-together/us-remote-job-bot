// Tiny helpers shared across the poller, worker and clients.

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
